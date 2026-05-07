import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { CredentialsVaultService } from './credentials-vault.service';
import { IbkrClient } from '@smartvest/brokers';

/**
 * Phase B.4 — IBKR session keep-alive cron.
 *
 * IBKR Client Portal Web API maintient les sessions auth pendant ~5-10 min
 * sans activité. Pour éviter les déco intempestives en production, on ping
 * /sso/validate toutes les 3 min sur chaque connexion IBKR active.
 *
 * Comportement :
 *   - GET broker_connections WHERE provider='INTERACTIVE_BROKERS' AND status='active'
 *   - Pour chaque : fetch credentials du Vault → instantiate IbkrClient → validateSession()
 *   - Si valid → UPDATE last_sync_at=NOW()
 *   - Si invalid (401) → UPDATE status='expired', last_error_message='session_expired'
 *   - Si error réseau → log warning, ne change pas status (retry au cycle suivant)
 *
 * Activation : `BROKER_RECONCILIATION_ENABLED=true` (master flag, off par défaut).
 *
 * Pas de side-effect runtime tant que :
 *   - Aucune connexion IBKR active en DB
 *   - OU le flag BROKER_RECONCILIATION_ENABLED=false
 */
@Injectable()
export class IbkrSessionKeepAliveService {
  private readonly logger = new Logger(IbkrSessionKeepAliveService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly vault: CredentialsVaultService,
  ) {}

  /**
   * Cron toutes les 3 min. Active uniquement si BROKER_RECONCILIATION_ENABLED.
   * Cf. CLAUDE.md §6 ter — kill-switch global propage automatiquement.
   */
  @Cron('0 */3 * * * *', { name: 'ibkr-session-keepalive' })
  async runKeepAliveCron(): Promise<void> {
    const enabled = (process.env.FEATURE_BROKER_RECONCILIATION_ENABLED ?? 'false').toLowerCase() === 'true';
    if (!enabled) return;
    try {
      await this.runKeepAliveInner();
    } catch (e) {
      this.logger.error(`[ibkr-keepalive] cycle failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runKeepAliveInner(): Promise<void> {
    const { data: connections, error } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('id, user_id, credentials_vault_ref')
      .eq('provider', 'INTERACTIVE_BROKERS')
      .eq('status', 'active');

    if (error) {
      this.logger.warn(`[ibkr-keepalive] fetch connections failed: ${error.message}`);
      return;
    }
    if (!connections || connections.length === 0) return;

    this.logger.debug(`[ibkr-keepalive] checking ${connections.length} active IBKR session(s)`);

    for (const conn of connections) {
      await this.checkOneSession(conn).catch((e) => {
        this.logger.warn(
          `[ibkr-keepalive] connection ${String(conn.id).slice(0, 8)}: check failed (${String(e).slice(0, 100)})`,
        );
      });
    }
  }

  private async checkOneSession(conn: {
    id: string;
    user_id: string;
    credentials_vault_ref: string | null;
  }): Promise<void> {
    if (!conn.credentials_vault_ref) {
      // Pas de credentials = MANUAL placeholder qui ne devrait pas être en
      // status='active' pour IBKR. On marque error pour signaler.
      await this.markStatus(conn.id, 'error', 'no_credentials_vault_ref');
      return;
    }

    let credentials: Awaited<ReturnType<CredentialsVaultService['fetch']>>;
    try {
      credentials = await this.vault.fetch(conn.credentials_vault_ref);
    } catch (e) {
      // Vault unreachable — ne change pas le status, retry cycle suivant.
      this.logger.warn(
        `[ibkr-keepalive] vault fetch failed for ${conn.id.slice(0, 8)}: ${String(e).slice(0, 80)}`,
      );
      return;
    }

    if (!credentials) {
      await this.markStatus(conn.id, 'error', 'vault_returned_null');
      return;
    }
    if (credentials.provider !== 'INTERACTIVE_BROKERS') {
      await this.markStatus(conn.id, 'error', 'wrong_provider_in_vault');
      return;
    }

    const client = new IbkrClient({
      sessionToken: credentials.sessionToken,
      accountId: credentials.accountId,
    });

    try {
      const valid = await client.validateSession();
      if (valid) {
        await this.markValidated(conn.id);
      } else {
        await this.markStatus(conn.id, 'expired', 'ibkr_session_expired_401');
      }
    } catch (e) {
      this.logger.warn(
        `[ibkr-keepalive] validateSession failed for ${conn.id.slice(0, 8)}: ${String(e).slice(0, 80)}`,
      );
      // Ne change pas le status — erreur réseau/serveur transient.
    }
  }

  private async markValidated(connectionId: string): Promise<void> {
    await this.supabase
      .getClient()
      .from('broker_connections')
      .update({
        last_sync_at: new Date().toISOString(),
        last_error_message: null,
      })
      .eq('id', connectionId);
  }

  private async markStatus(
    connectionId: string,
    status: 'expired' | 'error',
    errorMessage: string,
  ): Promise<void> {
    await this.supabase
      .getClient()
      .from('broker_connections')
      .update({
        status,
        last_error_at: new Date().toISOString(),
        last_error_message: errorMessage,
      })
      .eq('id', connectionId);
    this.logger.log(
      `[ibkr-keepalive] connection ${connectionId.slice(0, 8)} → status=${status} (${errorMessage})`,
    );
  }
}
