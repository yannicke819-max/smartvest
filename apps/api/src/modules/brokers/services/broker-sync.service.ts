import { Injectable, BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { CredentialsVaultService } from './credentials-vault.service';
import { BrokersAuditService } from './brokers-audit.service';
import { createBrokerAdapter } from '@smartvest/brokers';
import type { BrokerProvider } from '@smartvest/domain';

type ConnectionRow = {
  id: string;
  user_id: string;
  provider: BrokerProvider;
  status: string;
  credentials_vault_ref: string | null;
};

/**
 * BrokerSyncService — dedicated orchestration of a sync run.
 * Idempotent per job id. Short-circuits if :
 *   - AUTONOMY_KILL_SWITCH is on (→ 'sync_cancelled_by_kill_switch')
 *   - BROKER_SYNC_READ_ONLY_ENABLED is off (→ ForbiddenException)
 *
 * Note : this commit does NOT yet cancel in-flight syncs when a mandate
 * becomes invalid mid-run. The check happens ONLY at job start. Mid-run
 * mandate invalidation is a future improvement (requires streaming).
 */
@Injectable()
export class BrokerSyncService {
  private readonly logger = new Logger(BrokerSyncService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flags: FeatureFlagsService,
    private readonly vault: CredentialsVaultService,
    private readonly audit: BrokersAuditService,
  ) {}

  private adapterFlags() {
    return {
      BROKER_CONNECTIONS_ENABLED: this.flags.isEnabled('BROKER_CONNECTIONS_ENABLED'),
      BROKER_ADAPTER_IB_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_IB_ENABLED'),
      BROKER_ADAPTER_SAXO_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_SAXO_ENABLED'),
      BROKER_ADAPTER_DEGIRO_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_DEGIRO_ENABLED'),
      BROKER_ADAPTER_TRADING212_ENABLED: this.flags.isEnabled('BROKER_ADAPTER_TRADING212_ENABLED'),
    };
  }

  async run(connectionId: string, userId: string) {
    if (!this.flags.isEnabled('BROKER_SYNC_READ_ONLY_ENABLED')) {
      throw new ForbiddenException('Sync lecture seule désactivée (BROKER_SYNC_READ_ONLY_ENABLED=false)');
    }

    const { data: row, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('*')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    if (error || !row) throw new NotFoundException('Connexion introuvable');
    const conn = row as ConnectionRow;

    if (conn.status === 'revoked' || conn.status === 'expired') {
      throw new BadRequestException(`Connexion ${conn.status} — sync impossible`);
    }

    const jobId = uuid();
    const startedAt = new Date().toISOString();

    // Pre-sync kill-switch check.
    if (this.flags.isEnabled('AUTONOMY_KILL_SWITCH')) {
      await this.recordJob(jobId, connectionId, userId, {
        status: 'cancelled',
        started_at: startedAt,
        finished_at: startedAt,
        cancel_reason: 'kill_switch_global',
        positions_count: 0, cash_count: 0, transactions_count: 0,
        errors: [],
      });
      await this.audit.write({
        userId, connectionId, syncJobId: jobId,
        kind: 'sync_cancelled_by_kill_switch',
        reason: 'Kill-switch global actif — sync annulée avant exécution',
      });
      return { jobId, status: 'cancelled' as const, cancelled: 'kill_switch' };
    }

    await this.recordJob(jobId, connectionId, userId, {
      status: 'running',
      started_at: startedAt,
      positions_count: 0, cash_count: 0, transactions_count: 0,
      errors: [],
    });
    await this.audit.write({
      userId, connectionId, syncJobId: jobId,
      kind: 'sync_started',
      reason: `Sync démarrée sur ${conn.provider}`,
    });

    let adapter;
    try {
      adapter = createBrokerAdapter(conn.provider, this.adapterFlags());
    } catch (e) {
      await this.failJob(jobId, connectionId, userId, (e as Error).message);
      return { jobId, status: 'failed' as const, error: (e as Error).message };
    }

    // MANUAL returns empty — still counted as success.
    if (conn.credentials_vault_ref && conn.provider !== 'MANUAL') {
      const creds = await this.vault.fetch(conn.credentials_vault_ref);
      if (!creds) {
        await this.failJob(jobId, connectionId, userId, 'Credentials introuvables dans le Vault');
        return { jobId, status: 'failed' as const, error: 'vault_miss' };
      }
      try {
        await adapter.connect(creds);
      } catch (e) {
        await this.failJob(jobId, connectionId, userId, `connect: ${(e as Error).message}`);
        return { jobId, status: 'failed' as const, error: (e as Error).message };
      }
    }

    const errors: Array<{ code: string; message: string }> = [];
    let positions: unknown[] = [], cash: unknown[] = [], transactions: unknown[] = [];
    try { positions = await adapter.fetchPositions(); } catch (e) { errors.push({ code: 'positions', message: (e as Error).message }); }
    try { cash = await adapter.fetchCash(); } catch (e) { errors.push({ code: 'cash', message: (e as Error).message }); }
    try { transactions = await adapter.fetchTransactions(); } catch (e) { errors.push({ code: 'transactions', message: (e as Error).message }); }

    const finishedAt = new Date().toISOString();
    const status = errors.length === 0 ? 'success' : (positions.length + cash.length + transactions.length > 0 ? 'partial' : 'failed');

    await this.recordJob(jobId, connectionId, userId, {
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      positions_count: positions.length,
      cash_count: cash.length,
      transactions_count: transactions.length,
      errors,
    });

    await this.supabase
      .getClient()
      .from('broker_connections')
      .update({ last_sync_at: finishedAt, updated_at: finishedAt })
      .eq('id', connectionId)
      .eq('user_id', userId);

    await this.audit.write({
      userId, connectionId, syncJobId: jobId,
      kind: status === 'failed' ? 'sync_failed' : 'sync_completed',
      reason: `Sync ${status} — ${positions.length} positions, ${cash.length} cash, ${transactions.length} transactions, ${errors.length} erreurs`,
    });

    return { jobId, status, positions: positions.length, cash: cash.length, transactions: transactions.length, errors };
  }

  private async recordJob(
    jobId: string, connectionId: string, userId: string,
    fields: Record<string, unknown>,
  ) {
    const existing = await this.supabase
      .getClient()
      .from('broker_sync_jobs')
      .select('id')
      .eq('id', jobId)
      .maybeSingle();
    if (existing.data) {
      await this.supabase
        .getClient()
        .from('broker_sync_jobs')
        .update(fields)
        .eq('id', jobId);
    } else {
      await this.supabase
        .getClient()
        .from('broker_sync_jobs')
        .insert({ id: jobId, connection_id: connectionId, user_id: userId, ...fields });
    }
  }

  private async failJob(jobId: string, connectionId: string, userId: string, message: string) {
    await this.recordJob(jobId, connectionId, userId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      errors: [{ code: 'fatal', message }],
    });
    await this.audit.write({
      userId, connectionId, syncJobId: jobId,
      kind: 'sync_failed', reason: message,
    });
  }

  async listJobs(connectionId: string, userId: string, limit = 20) {
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_sync_jobs')
      .select('*')
      .eq('connection_id', connectionId)
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }
}
