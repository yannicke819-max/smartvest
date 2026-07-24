/**
 * GET /health/vitals — DEAD MAN'S SWITCH des boucles vitales oversold.
 *
 * Incident 24/07/2026 : un await pendu a gelé les scans oversold ~4h pendant
 * que /health (liveness web) répondait 200 — machine « verte » à moitié morte,
 * invisible pour Fly. Même famille : collecteur news 11/06, scanner gainers
 * 22/05 (cf. scanner-pulse). Ce endpoint prouve EN BASE que les boucles battent :
 *
 *   · SCANS oversold : dernier event scan (completed/blocked) — attendu toutes
 *     les ≤15 min DANS la fenêtre lun-ven 08-20 UTC. Budget default 35 min
 *     (OVERSOLD_VITALS_SCAN_MAX_AGE_MIN) = 2 cadences ratées + marge.
 *   · NEWS : dernier article ingéré (cron 10 min, 24/7). Budget default 45 min
 *     (OVERSOLD_VITALS_NEWS_MAX_AGE_MIN). Skippé si EODHD_NEWS_PERSIST_ENABLED=false.
 *
 * 503 si UN vital est stale → wiré en [[http_service.checks]] Fly → restart
 * auto (~60s) au lieu d'un gel silencieux. Anti-faux-positifs :
 *   · fenêtre-aware (nuit/weekend = silence normal) ;
 *   · warmup 10 min post-boot (jamais de 503 pendant le démarrage) ;
 *   · fail-OPEN sur erreur Supabase (un blip DB ne doit pas tuer la machine) ;
 *   · idle si aucun portfolio oversold actif (env de dev/test).
 * Master off : OVERSOLD_VITALS_ENABLED=false.
 */

import { Controller, Get, HttpCode, HttpStatus, Logger, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { SupabaseService } from '../supabase/supabase.service';
import { isOversoldScanWindow, skippedVital, vitalVerdict, type VitalCheck } from './vitals.helper';

interface VitalsPayload {
  status: 'healthy' | 'stale' | 'idle' | 'warming';
  uptime_sec: number;
  vitals: VitalCheck[];
}

@Controller('health')
export class VitalsController {
  private readonly logger = new Logger(VitalsController.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Get('vitals')
  @HttpCode(HttpStatus.OK)
  async getVitals(@Res({ passthrough: true }) res: Response): Promise<VitalsPayload> {
    const uptimeSec = Math.floor(process.uptime());
    const enabled = (this.config.get<string>('OVERSOLD_VITALS_ENABLED') ?? 'true').toLowerCase() === 'true';
    const scanBudgetSec = Math.max(1, Number(this.config.get<string>('OVERSOLD_VITALS_SCAN_MAX_AGE_MIN') ?? '35')) * 60;
    const newsBudgetSec = Math.max(1, Number(this.config.get<string>('OVERSOLD_VITALS_NEWS_MAX_AGE_MIN') ?? '45')) * 60;

    if (!enabled) return { status: 'idle', uptime_sec: uptimeSec, vitals: [] };
    // Warmup : les crons n'ont pas encore eu le temps de battre après un boot.
    if (uptimeSec < 600) return { status: 'warming', uptime_sec: uptimeSec, vitals: [] };
    if (!this.supabase.isReady()) return { status: 'idle', uptime_sec: uptimeSec, vitals: [] };

    const client = this.supabase.getClient();
    const vitals: VitalCheck[] = [];
    const now = new Date();

    try {
      // Vital 1 — SCANS oversold (fenêtre-aware, seulement si ≥1 portfolio oversold).
      if (!isOversoldScanWindow(now)) {
        vitals.push(skippedVital('oversold_scans', 'hors fenêtre (lun-ven 08-20 UTC)', scanBudgetSec));
      } else {
        const { data: cfgs, error: cfgErr } = await client
          .from('lisa_session_configs')
          .select('portfolio_id')
          .eq('strategy_mode', 'oversold')
          .limit(1);
        if (cfgErr) {
          vitals.push(skippedVital('oversold_scans', `db err: ${cfgErr.message.slice(0, 60)}`, scanBudgetSec));
        } else if (!cfgs || cfgs.length === 0) {
          vitals.push(skippedVital('oversold_scans', 'aucun portfolio oversold', scanBudgetSec));
        } else {
          const { data: rows, error: logErr } = await client
            .from('lisa_decision_log')
            .select('timestamp')
            .in('kind', ['oversold_intraday_scan_completed', 'oversold_scan_blocked_regime', 'oversold_scan_completed'])
            .order('timestamp', { ascending: false })
            .limit(1);
          if (logErr) {
            vitals.push(skippedVital('oversold_scans', `db err: ${logErr.message.slice(0, 60)}`, scanBudgetSec));
          } else {
            vitals.push(vitalVerdict('oversold_scans', rows?.[0]?.timestamp ?? null, scanBudgetSec, now));
          }
        }
      }

      // Vital 2 — NEWS (24/7, seulement si la persistance news est active).
      const newsEnabled = (this.config.get<string>('EODHD_NEWS_PERSIST_ENABLED') ?? 'false').toLowerCase() === 'true';
      if (!newsEnabled) {
        vitals.push(skippedVital('news_ingest', 'EODHD_NEWS_PERSIST_ENABLED=false', newsBudgetSec));
      } else {
        const { data: nrows, error: nErr } = await client
          .from('eodhd_news_articles')
          .select('fetched_at')
          .order('fetched_at', { ascending: false })
          .limit(1);
        if (nErr) {
          vitals.push(skippedVital('news_ingest', `db err: ${nErr.message.slice(0, 60)}`, newsBudgetSec));
        } else {
          vitals.push(vitalVerdict('news_ingest', nrows?.[0]?.fetched_at ?? null, newsBudgetSec, now));
        }
      }
    } catch (e) {
      // Fail-OPEN : jamais de 503 sur une exception imprévue (un blip ne tue pas la machine).
      this.logger.warn(`[vitals] exception: ${String(e).slice(0, 150)}`);
      return { status: 'idle', uptime_sec: uptimeSec, vitals };
    }

    const stale = vitals.filter((v) => !v.ok);
    if (stale.length > 0) {
      this.logger.error(
        `[vitals] 🔴 STALE → 503 (Fly va redémarrer la machine) : ${stale
          .map((v) => `${v.name} age=${v.age_sec ?? '?'}s > ${v.budget_sec}s`)
          .join(' · ')}`,
      );
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'stale', uptime_sec: uptimeSec, vitals };
    }
    return { status: 'healthy', uptime_sec: uptimeSec, vitals };
  }
}
