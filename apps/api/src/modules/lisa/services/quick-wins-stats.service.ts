import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export interface QwStatsRow {
  qw_id: string;
  total: number;
  pass: number;
  block: number;
  modify: number;
  shadow_would_have_passed: number;
  pct_block: number;
  pct_modify: number;
}

export interface QwRecentEntry {
  id: string;
  created_at: string;
  qw_id: string;
  symbol: string;
  asset_class: string;
  decision: string;
  reason: string;
  would_have_passed_without_flag: boolean;
}

/**
 * PR #338 — agrégation des décisions Quick Wins (table `qw_decision_log`,
 * migration 0140) pour le dashboard UI activity.
 *
 * stats24h : agrégation par qw_id sur la fenêtre 24h glissante.
 * recent   : N dernières décisions (clamp [1, 200]).
 */
@Injectable()
export class QuickWinsStatsService {
  constructor(private readonly supabase: SupabaseService) {}

  async stats24h(): Promise<QwStatsRow[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('qw_decision_log')
      .select('qw_id, decision, would_have_passed_without_flag')
      .gte('created_at', since)
      .limit(50_000);
    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Array<{
      qw_id: string;
      decision: string;
      would_have_passed_without_flag: boolean;
    }>;

    const byQw = new Map<string, QwStatsRow>();
    for (const r of rows) {
      const cur = byQw.get(r.qw_id) ?? {
        qw_id: r.qw_id,
        total: 0,
        pass: 0,
        block: 0,
        modify: 0,
        shadow_would_have_passed: 0,
        pct_block: 0,
        pct_modify: 0,
      };
      cur.total += 1;
      if (r.decision === 'pass') cur.pass += 1;
      else if (r.decision === 'block') cur.block += 1;
      else if (r.decision === 'modify') cur.modify += 1;
      if (r.would_have_passed_without_flag) cur.shadow_would_have_passed += 1;
      byQw.set(r.qw_id, cur);
    }

    return Array.from(byQw.values())
      .map((r) => ({
        ...r,
        pct_block: r.total > 0 ? Math.round((r.block / r.total) * 1000) / 10 : 0,
        pct_modify: r.total > 0 ? Math.round((r.modify / r.total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.qw_id.localeCompare(b.qw_id));
  }

  async recent(limit = 50): Promise<QwRecentEntry[]> {
    const clamped = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
    const { data, error } = await this.supabase
      .getClient()
      .from('qw_decision_log')
      .select('id, created_at, qw_id, symbol, asset_class, decision, reason, would_have_passed_without_flag')
      .order('created_at', { ascending: false })
      .limit(clamped);
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as QwRecentEntry[];
  }
}
