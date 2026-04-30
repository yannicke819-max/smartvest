import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { CredentialsVaultService } from '../brokers/services/credentials-vault.service';

// Rate limit: 3 DELETE attempts per 60-second window per user.
const DELETE_MAX = 3;
const DELETE_WINDOW_MS = 60_000;

interface RateLimitEntry {
  attempts: number;
  windowStart: number;
}

@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);
  private readonly deleteRateMap = new Map<string, RateLimitEntry>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly vault: CredentialsVaultService,
  ) {}

  // ─── Live JWT validation ───────────────────────────────────────────

  async validateToken(authorization: string | undefined): Promise<{ userId: string; email: string | undefined }> {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token Bearer manquant');
    }
    const token = authorization.slice(7);
    const { data, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !data.user?.id) {
      throw new UnauthorizedException('Token invalide ou expiré');
    }
    return { userId: data.user.id, email: data.user.email };
  }

  // ─── Rate limiter (DELETE only) ────────────────────────────────────

  checkDeleteRateLimit(userId: string): void {
    const now = Date.now();
    const entry = this.deleteRateMap.get(userId);
    if (!entry || now - entry.windowStart > DELETE_WINDOW_MS) {
      this.deleteRateMap.set(userId, { attempts: 1, windowStart: now });
      return;
    }
    if (entry.attempts >= DELETE_MAX) {
      throw new HttpException(
        { message: 'Trop de tentatives. Réessayez dans 60 secondes.', statusCode: 429 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.attempts += 1;
  }

  // ─── RGPD Export ──────────────────────────────────────────────────

  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    const db = this.supabase.getClient();

    const [
      profile,
      portfolios,
      positions,
      goals,
      alerts,
      funding,
      lisaDecisions,
      paperTrades,
      brokerConnections,
      sniperSessions,
    ] = await Promise.all([
      db.from('user_profiles').select('*').eq('user_id', userId).maybeSingle(),
      db.from('portfolios').select('*').eq('user_id', userId),
      db.from('positions').select('*').eq('user_id', userId),
      db.from('goals').select('*').eq('user_id', userId),
      db.from('alerts').select('*').eq('user_id', userId),
      db.from('funding_transfers').select('*').eq('user_id', userId),
      db.from('lisa_decision_log').select('*').eq('user_id', userId).limit(1000).order('created_at', { ascending: false }),
      db.from('paper_trades').select('*').eq('user_id', userId).limit(500).order('created_at', { ascending: false }),
      // Explicit column list — NEVER expose credentials_vault_ref
      db.from('broker_connections').select(
        'id, user_id, provider, label, status, supports_read, supports_execution, supports_streaming, supports_options, supports_crypto, supports_csv_import, connected_at, last_sync_at, meta, created_at, updated_at',
      ).eq('user_id', userId),
      db.from('sniper_sessions').select(
        'id, user_id, status, started_at, expires_at, ended_at, revoke_reason, ttl_minutes',
      ).eq('user_id', userId),
    ]);

    return {
      schemaVersion: '1',
      exportedAt: new Date().toISOString(),
      userId,
      profile: profile.data ?? null,
      portfolios: portfolios.data ?? [],
      positions: positions.data ?? [],
      goals: goals.data ?? [],
      alerts: alerts.data ?? [],
      fundingTransfers: funding.data ?? [],
      lisaDecisionLog: lisaDecisions.data ?? [],
      paperTrades: paperTrades.data ?? [],
      brokerConnections: brokerConnections.data ?? [],
      sniperSessions: sniperSessions.data ?? [],
    };
  }

  // ─── RGPD Account Deletion ────────────────────────────────────────

  async deleteAccount(
    userId: string,
    userEmail: string | undefined,
    rawIp: string | undefined,
  ): Promise<void> {
    const db = this.supabase.getClient();
    const ipHash = MeService.hashIp(rawIp);

    // 1. Insert audit row (initiated)
    const { data: auditRow, error: auditInsertError } = await db
      .from('account_deletion_audit')
      .insert({
        user_id: userId,
        user_email: userEmail ?? null,
        ip_hash: ipHash ?? null,
        status: 'initiated',
      })
      .select('id')
      .single();

    if (auditInsertError) {
      this.logger.error(`audit insert failed user=${userId.slice(0, 8)}: ${auditInsertError.message}`);
    }
    const auditId = auditRow?.id as string | undefined;

    try {
      // 2. Purge Vault secrets for broker_connections
      const { data: connections } = await db
        .from('broker_connections')
        .select('credentials_vault_ref')
        .eq('user_id', userId);

      if (connections?.length) {
        await Promise.allSettled(
          (connections as Array<{ credentials_vault_ref: string | null }>)
            .filter((c) => c.credentials_vault_ref)
            .map((c) => this.vault.clear(c.credentials_vault_ref as string)),
        );
        this.logger.log(`Vault purged ${connections.length} secret(s) for user=${userId.slice(0, 8)}`);
      }

      // 3. Delete the Supabase Auth user → cascades all rows via ON DELETE CASCADE
      const { error: deleteError } = await db.auth.admin.deleteUser(userId);
      if (deleteError) {
        throw new Error(`auth.admin.deleteUser failed: ${deleteError.message}`);
      }

      // 4. Mark audit row completed
      if (auditId) {
        await db
          .from('account_deletion_audit')
          .update({ status: 'completed', completed_at: new Date().toISOString() })
          .eq('id', auditId);
      }

      this.logger.log(`Account deleted: user=${userId.slice(0, 8)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`deleteAccount failed user=${userId.slice(0, 8)}: ${msg}`);
      if (auditId) {
        await db
          .from('account_deletion_audit')
          .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: msg })
          .eq('id', auditId);
      }
      throw err;
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────

  static hashIp(ip: string | undefined): string | undefined {
    if (!ip) return undefined;
    return createHash('sha256').update(ip).digest('hex');
  }
}
