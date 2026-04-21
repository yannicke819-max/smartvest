import {
  Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { CredentialsVaultService } from './credentials-vault.service';
import { BrokersAuditService } from './brokers-audit.service';
import { createBrokerAdapter } from '@smartvest/brokers';
import type { BrokerCredentials, BrokerProvider } from '@smartvest/domain';
import { PROVIDER_CAPABILITIES } from '@smartvest/domain';
import type { CreateConnectionDto, UpdateConnectionDto } from '../dto/brokers.dto';

type ConnectionRow = Record<string, unknown> & {
  id: string; user_id: string; provider: BrokerProvider; status: string;
  credentials_vault_ref: string | null;
};

/**
 * BrokersService — orchestrates creation, update, test and revoke of
 * BrokerConnection rows. The credentials ALWAYS pass through the Vault;
 * the row itself never holds secret material. Sync is delegated to
 * BrokerSyncService (separate class) for clean separation.
 */
@Injectable()
export class BrokersService {
  private readonly logger = new Logger(BrokersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flags: FeatureFlagsService,
    private readonly vault: CredentialsVaultService,
    private readonly audit: BrokersAuditService,
  ) {}

  private requireModuleEnabled() {
    if (!this.flags.isEnabled('BROKER_CONNECTIONS_ENABLED')) {
      throw new ForbiddenException('Module broker désactivé');
    }
  }

  private adapterFlags() {
    return {
      BROKER_CONNECTIONS_ENABLED: this.flags.isEnabled('BROKER_CONNECTIONS_ENABLED'),
      BROKER_ADAPTER_IB_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_IB_ENABLED'),
      BROKER_ADAPTER_SAXO_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_SAXO_ENABLED'),
      BROKER_ADAPTER_DEGIRO_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_DEGIRO_ENABLED'),
      BROKER_ADAPTER_TRADING212_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_TRADING212_ENABLED'),
    };
  }

  async list(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('id, user_id, provider, label, status, supports_read, supports_execution, supports_streaming, supports_options, supports_crypto, supports_csv_import, connected_at, last_sync_at, last_error_at, last_error_message, meta, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async get(id: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      // Explicit column list — NEVER select credentials_vault_ref here.
      .select('id, user_id, provider, label, status, supports_read, supports_execution, supports_streaming, supports_options, supports_crypto, supports_csv_import, connected_at, last_sync_at, last_error_at, last_error_message, meta, created_at, updated_at')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Connexion introuvable');
    return data;
  }

  async create(userId: string, dto: CreateConnectionDto) {
    this.requireModuleEnabled();
    if (dto.credentials.provider !== dto.provider) {
      throw new BadRequestException('Incohérence provider / credentials.provider');
    }
    const id = uuid();
    const caps = PROVIDER_CAPABILITIES[dto.provider];
    const vaultRef = await this.vault.store(userId, dto.credentials);

    const { data, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .insert({
        id,
        user_id: userId,
        provider: dto.provider,
        label: dto.label,
        status: 'pending',
        supports_read: caps.supportsRead,
        supports_execution: caps.supportsExecution,
        supports_streaming: caps.supportsStreaming,
        supports_options: caps.supportsOptions,
        supports_crypto: caps.supportsCrypto,
        supports_csv_import: caps.supportsCsvImport,
        credentials_vault_ref: vaultRef,
        meta: {},
      })
      .select('id, user_id, provider, label, status, supports_read, supports_execution, supports_streaming, supports_options, supports_crypto, supports_csv_import, connected_at, last_sync_at, last_error_at, last_error_message, meta, created_at, updated_at')
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Création impossible');

    await this.audit.write({
      userId, connectionId: id, kind: 'connection_created',
      reason: `Connexion ${dto.provider} créée (${dto.label})`,
    });
    await this.audit.write({
      userId, connectionId: id, kind: 'credentials_stored',
      reason: 'Credentials stockés dans Supabase Vault',
    });
    return data;
  }

  async update(id: string, userId: string, dto: UpdateConnectionDto) {
    this.requireModuleEnabled();
    const row = await this.getInternal(id, userId);
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.label !== undefined) updates.label = dto.label;

    if (dto.credentials !== undefined) {
      if (dto.credentials.provider !== row.provider) {
        throw new BadRequestException('Provider des nouveaux credentials différent');
      }
      const newRef = await this.vault.rotate(userId, dto.credentials);
      const oldRef = row.credentials_vault_ref;
      updates.credentials_vault_ref = newRef;
      // After updating the row, delete the old secret.
      const { error } = await this.supabase
        .getClient()
        .from('broker_connections')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId);
      if (error) throw new BadRequestException(error.message);
      if (oldRef) await this.vault.clear(oldRef);
      await this.audit.write({
        userId, connectionId: id, kind: 'credentials_rotated',
        reason: 'Credentials rotés dans le Vault',
      });
    } else {
      const { error } = await this.supabase
        .getClient()
        .from('broker_connections')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId);
      if (error) throw new BadRequestException(error.message);
      await this.audit.write({
        userId, connectionId: id, kind: 'connection_updated',
        reason: 'Métadonnées mises à jour',
      });
    }
    return this.get(id, userId);
  }

  async revoke(id: string, userId: string) {
    // Deactivation is never gated by module flag — safety wins.
    const row = await this.getInternal(id, userId);
    await this.supabase
      .getClient()
      .from('broker_connections')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (row.credentials_vault_ref) await this.vault.clear(row.credentials_vault_ref);
    await this.supabase
      .getClient()
      .from('broker_connections')
      .update({ credentials_vault_ref: null })
      .eq('id', id)
      .eq('user_id', userId);
    await this.audit.write({
      userId, connectionId: id, kind: 'connection_revoked',
      reason: 'Révocation utilisateur — credentials supprimés du Vault',
    });
    return this.get(id, userId);
  }

  async test(id: string, userId: string) {
    this.requireModuleEnabled();
    const row = await this.getInternal(id, userId);
    const adapter = createBrokerAdapter(row.provider, this.adapterFlags());

    // Fetch creds from vault — never returned to client.
    if (row.credentials_vault_ref) {
      const creds = await this.vault.fetch(row.credentials_vault_ref);
      if (!creds) throw new BadRequestException('Credentials introuvables dans le Vault');
      try {
        await adapter.connect(creds);
      } catch (e) {
        await this.audit.write({
          userId, connectionId: id, kind: 'connection_tested_failed',
          reason: (e as Error).message,
        });
        throw new BadRequestException((e as Error).message);
      }
    }

    const result = await adapter.testConnection();
    await this.audit.write({
      userId, connectionId: id,
      kind: result.ok ? 'connection_tested_ok' : 'connection_tested_failed',
      reason: result.message,
    });
    if (result.ok) {
      await this.supabase
        .getClient()
        .from('broker_connections')
        .update({ status: 'active', connected_at: new Date().toISOString() })
        .eq('id', id);
    }
    return result;
  }

  async listAccounts(connectionId: string, userId: string) {
    await this.get(connectionId, userId); // ownership check
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_accounts')
      .select('*')
      .eq('connection_id', connectionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async listAudit(connectionId: string, userId: string) {
    await this.get(connectionId, userId);
    return this.audit.listForConnection(connectionId, userId);
  }

  /**
   * Internal ownership-checked fetch that INCLUDES credentials_vault_ref.
   * Never expose this row through any public endpoint.
   */
  private async getInternal(id: string, userId: string): Promise<ConnectionRow> {
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Connexion introuvable');
    return data as ConnectionRow;
  }
}
