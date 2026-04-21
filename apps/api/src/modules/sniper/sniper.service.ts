import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuid } from 'uuid';
import { timingSafeEqual } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

const DEFAULT_TTL = 15;

type SessionRow = {
  id: string;
  user_id: string;
  status: 'unlocked' | 'expired' | 'revoked';
  unlock_method: 'local_code';
  unlocked_at: string;
  expires_at: string;
  revoked_at: string | null;
  ttl_minutes: number;
  created_at: string;
  updated_at: string;
};

export type SniperStatusResponse = {
  mode: 'STANDARD' | 'SNIPER_LOCKED' | 'SNIPER_ACTIVE';
  session: SessionRow | null;
  /** Seconds remaining until auto-expiry when active, otherwise null. */
  secondsRemaining: number | null;
};

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class SniperService {
  private readonly logger = new Logger(SniperService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  private getConfiguredCode(): string | null {
    const code = this.config.get<string>('SNIPER_MODE_UNLOCK_CODE');
    return code && code.length > 0 ? code : null;
  }

  private getDefaultTtl(): number {
    const raw = this.config.get<string>('SNIPER_MODE_TTL_MINUTES');
    const n = raw ? parseInt(raw, 10) : DEFAULT_TTL;
    return Number.isFinite(n) && n > 0 && n <= 240 ? n : DEFAULT_TTL;
  }

  /**
   * Reconciles any stale row: an "unlocked" session whose expires_at has passed
   * is mutated to "expired" on the next read. Keeps the derived mode accurate
   * without a background job.
   */
  private async reconcile(row: SessionRow | null): Promise<SessionRow | null> {
    if (!row) return null;
    if (row.status !== 'unlocked') return row;
    if (new Date(row.expires_at) > new Date()) return row;
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('sniper_sessions')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('id', row.id)
      .select()
      .single();
    if (error) {
      this.logger.warn(`Failed to reconcile expired sniper session ${row.id}: ${error.message}`);
      return { ...row, status: 'expired' };
    }
    return data as SessionRow;
  }

  private async getLatest(userId: string): Promise<SessionRow | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('sniper_sessions')
      .select('*')
      .eq('user_id', userId)
      .order('unlocked_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return (data as SessionRow | null) ?? null;
  }

  async getStatus(userId: string): Promise<SniperStatusResponse> {
    const latest = await this.reconcile(await this.getLatest(userId));
    if (!latest) {
      return { mode: 'STANDARD', session: null, secondsRemaining: null };
    }
    const now = new Date();
    if (latest.status === 'unlocked' && new Date(latest.expires_at) > now) {
      const secondsRemaining = Math.max(
        0,
        Math.floor((new Date(latest.expires_at).getTime() - now.getTime()) / 1000),
      );
      return { mode: 'SNIPER_ACTIVE', session: latest, secondsRemaining };
    }
    return { mode: 'SNIPER_LOCKED', session: latest, secondsRemaining: null };
  }

  async unlock(userId: string, code: string, ttlMinutes?: number): Promise<SessionRow> {
    const configured = this.getConfiguredCode();
    if (!configured) {
      throw new BadRequestException(
        'Aucun code de déverrouillage configuré (SNIPER_MODE_UNLOCK_CODE manquant côté serveur)',
      );
    }
    if (!constantTimeEquals(code, configured)) {
      // Do not leak whether the code is "close" — log at warn level and 401.
      this.logger.warn(`Sniper unlock attempt rejected for user ${userId}`);
      throw new UnauthorizedException('Code de déverrouillage invalide');
    }

    // Close any currently-unlocked session before starting a new one (one row at a time).
    await this.supabase
      .getClient()
      .from('sniper_sessions')
      .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('status', 'unlocked');

    const ttl = ttlMinutes ?? this.getDefaultTtl();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 60_000);

    const { data, error } = await this.supabase
      .getClient()
      .from('sniper_sessions')
      .insert({
        id: uuid(),
        user_id: userId,
        status: 'unlocked',
        unlock_method: 'local_code',
        unlocked_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        ttl_minutes: ttl,
      })
      .select()
      .single();
    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Déverrouillage impossible');
    }
    this.logger.log(`Sniper unlocked for user ${userId} (ttl=${ttl}m, expires=${expiresAt.toISOString()})`);
    return data as SessionRow;
  }

  async deactivate(userId: string): Promise<SessionRow> {
    const latest = await this.getLatest(userId);
    if (!latest) {
      throw new NotFoundException('Aucune session sniper à désactiver');
    }
    if (latest.status !== 'unlocked') {
      throw new BadRequestException(`Session déjà ${latest.status}`);
    }
    const nowIso = new Date().toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('sniper_sessions')
      .update({ status: 'revoked', revoked_at: nowIso, updated_at: nowIso })
      .eq('id', latest.id)
      .select()
      .single();
    if (error || !data) {
      throw new BadRequestException(error?.message ?? 'Désactivation impossible');
    }
    this.logger.log(`Sniper revoked for user ${userId}`);
    return data as SessionRow;
  }

  async listHistory(userId: string, limit = 20): Promise<SessionRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('sniper_sessions')
      .select('*')
      .eq('user_id', userId)
      .order('unlocked_at', { ascending: false })
      .limit(limit);
    if (error) throw new BadRequestException(error.message);
    return (data as SessionRow[]) ?? [];
  }

  /**
   * Convenience for other modules: cheap boolean check of whether the user
   * currently has an active sniper session. Does not hit the DB twice —
   * callers that already called getStatus() should reuse its result.
   */
  async isActive(userId: string): Promise<boolean> {
    const status = await this.getStatus(userId);
    return status.mode === 'SNIPER_ACTIVE';
  }
}
