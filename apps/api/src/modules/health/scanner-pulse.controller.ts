/**
 * GET /health/scanner-pulse — healthcheck DB-side du cycle scanner gainers.
 *
 * Rationale (incident 22-23/05/2026) : la machine Fly est restée joignable
 * (`/version` HTTP 200) pendant ~8h alors que le scanner cron ne tickait plus
 * (dernier `autopilot_cycle_completed` à 22/05 18:15 UTC, restart Fly à
 * 23/05 04:38). Fly ne pouvait pas détecter le zombie avec un simple liveness
 * check HTTP. Ce endpoint expose une preuve DB authoritative (last cycle ts)
 * et renvoie **503 si stale** → wirable comme [[http_service.checks]] Fly,
 * qui tuera la machine zombie et la relancera automatiquement.
 *
 * Indépendant de l'état in-process du scanner : interroge `lisa_decision_log`
 * directement. Fonctionne même si l'event-loop du scanner est mort silencieux.
 *
 * Pas de monitoring si aucun portfolio en mode gainers actif (sinon ce endpoint
 * renverrait 503 sur un environnement de test/dev où le scanner est OFF par
 * design).
 *
 * Threshold configurable via `SCANNER_PULSE_MAX_AGE_MIN` (default 20 min).
 * Default = 20 = ~1.3× le cycle 15min habituel, marge sans flap.
 */

import { Controller, Get, HttpCode, HttpStatus, Logger, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';

interface PulseOk {
  status: 'healthy' | 'idle';
  last_cycle_at: string | null;
  age_sec: number | null;
  max_age_sec: number;
}

interface PulseStale {
  status: 'stale';
  last_cycle_at: string | null;
  age_sec: number;
  max_age_sec: number;
  message: string;
}

@Controller('health')
export class ScannerPulseController {
  private readonly logger = new Logger(ScannerPulseController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get('scanner-pulse')
  @HttpCode(HttpStatus.OK)
  async getPulse(@Res({ passthrough: true }) res: Response): Promise<PulseOk | PulseStale> {
    const maxAgeMin = Number(this.config.get<string>('SCANNER_PULSE_MAX_AGE_MIN') ?? '20');
    const maxAgeSec = Math.max(1, maxAgeMin) * 60;

    const client = this.supabase.getClient();

    // (1) Y a-t-il au moins un portfolio en gainers ACTIF à monitorer ?
    const { data: cfgs, error: cfgErr } = await client
      .from('lisa_session_configs')
      .select('portfolio_id')
      .eq('strategy_mode', 'gainers')
      .eq('autopilot_enabled', true)
      .eq('kill_switch_active', false)
      .limit(1);

    if (cfgErr) {
      // DB injoignable → on ne peut PAS conclure stale ; on renvoie 200 idle pour
      // ne pas tuer la machine sur un blip Supabase (Fly redémarrerait inutilement).
      this.logger.warn(`[scanner-pulse] supabase err on configs: ${cfgErr.message}`);
      return { status: 'idle', last_cycle_at: null, age_sec: null, max_age_sec: maxAgeSec };
    }
    if (!cfgs || cfgs.length === 0) {
      // Aucun portfolio à monitorer → toujours healthy.
      return { status: 'idle', last_cycle_at: null, age_sec: null, max_age_sec: maxAgeSec };
    }

    // (2) Dernier autopilot_cycle_completed (toute portfolio confondue).
    const { data: rows, error: logErr } = await client
      .from('lisa_decision_log')
      .select('timestamp')
      .eq('kind', 'autopilot_cycle_completed')
      .order('timestamp', { ascending: false })
      .limit(1);

    if (logErr) {
      this.logger.warn(`[scanner-pulse] supabase err on decision_log: ${logErr.message}`);
      return { status: 'idle', last_cycle_at: null, age_sec: null, max_age_sec: maxAgeSec };
    }

    const lastTs = rows && rows.length > 0 ? rows[0].timestamp : null;
    if (!lastTs) {
      // Jamais cyclé (premier boot prod) — on tolère, le 1er cycle va venir.
      return { status: 'healthy', last_cycle_at: null, age_sec: null, max_age_sec: maxAgeSec };
    }

    const ageSec = Math.floor((Date.now() - new Date(lastTs).getTime()) / 1000);
    if (ageSec > maxAgeSec) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      const msg = `Scanner stale: last cycle ${ageSec}s ago (threshold ${maxAgeSec}s)`;
      this.logger.error(`[scanner-pulse] ${msg}`);
      return {
        status: 'stale',
        last_cycle_at: lastTs,
        age_sec: ageSec,
        max_age_sec: maxAgeSec,
        message: msg,
      };
    }
    return { status: 'healthy', last_cycle_at: lastTs, age_sec: ageSec, max_age_sec: maxAgeSec };
  }
}
