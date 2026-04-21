import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import type { BrokerCredentials } from '@smartvest/domain';

/**
 * CredentialsVaultService — wraps Supabase Vault.
 *
 * Contract :
 *  - store() returns an opaque vault reference (uuid string) that callers
 *    persist into broker_connections.credentials_vault_ref.
 *  - rotate() creates a NEW secret and leaves the old id for the caller to
 *    delete once the new ref is committed (atomicity concern — the caller
 *    updates the row then calls clear() on the old id).
 *  - fetch() returns the deserialised credentials object — RESTRICTED to
 *    backend services. It is NEVER exposed through any controller. The only
 *    code path that calls fetch() is the BrokerSyncService when preparing
 *    a live adapter instance.
 *  - clear() deletes a secret.
 *
 * Failure mode : if the Vault extension is not enabled in the project,
 * store() throws and callers should surface a clear error in the UI.
 * MANUAL connections bypass the vault entirely (no credentials needed).
 *
 * WARNING : every method in this service MUST log without payloads.
 * The credentials object never appears in log lines or error messages.
 */
@Injectable()
export class CredentialsVaultService {
  private readonly logger = new Logger(CredentialsVaultService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Persist credentials in Supabase Vault.
   * Uses `vault.create_secret(secret, name, description)` RPC.
   */
  async store(userId: string, credentials: BrokerCredentials): Promise<string> {
    if (credentials.provider === 'MANUAL') {
      // No secret material to store — return a sentinel ref so the row has one.
      return `manual:${uuid()}`;
    }

    const secretId = uuid();
    const payload = JSON.stringify(credentials);
    const name = `smartvest_broker_${userId.slice(0, 8)}_${credentials.provider}_${secretId}`;

    const { data, error } = await this.supabase.getClient().rpc('create_secret', {
      new_secret: payload,
      new_name: name,
      new_description: 'SmartVest broker credentials — never log.',
    });

    if (error) {
      // Log ONLY the message, never the payload.
      this.logger.error(`Vault store failed (user=${userId.slice(0, 8)}, provider=${credentials.provider}): ${error.message}`);
      throw new Error(
        'Impossible de stocker les credentials dans Supabase Vault. Vérifiez que l\'extension vault est activée.',
      );
    }

    // Supabase Vault's create_secret returns the new secret id as text.
    const ref = typeof data === 'string' ? data : String(data ?? secretId);
    this.logger.log(`Vault stored secret ref=${ref.slice(0, 8)}… for user=${userId.slice(0, 8)}`);
    return ref;
  }

  /**
   * Retrieve credentials. USE WITH CAUTION — only call from sync pipeline,
   * never from a controller.
   */
  async fetch(vaultRef: string): Promise<BrokerCredentials | null> {
    if (vaultRef.startsWith('manual:')) {
      return { provider: 'MANUAL', note: 'no-credentials' };
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('vault.decrypted_secrets')
      .select('decrypted_secret')
      .eq('id', vaultRef)
      .maybeSingle();
    if (error) {
      this.logger.warn(`Vault fetch failed for ref=${vaultRef.slice(0, 8)}…: ${error.message}`);
      return null;
    }
    const raw = (data as { decrypted_secret?: string } | null)?.decrypted_secret;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BrokerCredentials;
    } catch {
      this.logger.error(`Vault fetch: invalid JSON for ref=${vaultRef.slice(0, 8)}…`);
      return null;
    }
  }

  async clear(vaultRef: string): Promise<void> {
    if (vaultRef.startsWith('manual:')) return;
    const { error } = await this.supabase
      .getClient()
      .from('vault.secrets')
      .delete()
      .eq('id', vaultRef);
    if (error) {
      this.logger.warn(`Vault clear failed for ref=${vaultRef.slice(0, 8)}…: ${error.message}`);
    }
  }

  async rotate(userId: string, newCredentials: BrokerCredentials): Promise<string> {
    return this.store(userId, newCredentials);
  }
}
