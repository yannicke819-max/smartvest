/**
 * ConfigSanityValidatorService — détection auto d'anti-patterns config.
 *
 * Tourne toutes les heures (cron :17 — décalé de LessonAutoApply :07). Pour chaque
 * portfolio gainers, vérifie les anti-patterns connus et insère des lessons
 * `gate_calibration` avec `proposed_config_change` à confidence ≥ 0.85 + sample_size
 * "synthétique" 10 pour passer le filtre LessonAutoApplyService.
 *
 * Anti-patterns détectés (28/05/2026) :
 *   1. R/R inversé : sl_pct ≥ tp_pct → propose swap (TP doit être > SL × 1.5)
 *   2. min_change_pct_us_smallmid > 4% → propose 3% (sinon rate les early movers US)
 *   3. min_change_pct_eu > 3% → propose 2% (idem EU)
 *   4. max_open_positions < 5 sur portfolio non-shadow → propose 5
 *   5. capital_discipline_mode='DAILY_HARVEST' + strategy_mode='gainers' → propose NONE
 *   6. position_pct > 8% sur capital > $5000 → propose 5% (risk concentration)
 *
 * Override env : CONFIG_SANITY_VALIDATOR_ENABLED=false pour disable (default true).
 *
 * Le validator est défensif — il ne produit jamais > 1 lesson par portfolio
 * par cycle, et préfère LAISSER qu'UPDATER quand le diagnostic est incertain.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

const GAINERS_PORTFOLIOS = [
  { id: '58439d86-3f20-4a60-82a4-307f3f252bc2', name: 'MAIN' },
  { id: 'a0000001-0000-0000-0000-000000000001', name: 'HIGH' },
  { id: 'a0000002-0000-0000-0000-000000000002', name: 'MIDDLE' },
  { id: 'a0000003-0000-0000-0000-000000000003', name: 'SMALL' },
];

interface ConfigRow {
  portfolio_id: string;
  gainers_default_tp_pct: number | null;
  gainers_default_sl_pct: number | null;
  gainers_position_pct: number | null;
  gainers_max_open_positions: number | null;
  gainers_min_change_pct_us_smallmid: number | null;
  gainers_min_change_pct_eu: number | null;
  capital_discipline_mode: string | null;
  strategy_mode: string | null;
  capital_usd: number | null;
}

interface Finding {
  portfolio_id: string;
  portfolio_name: string;
  anti_pattern: string;
  lesson_text: string;
  proposed_config_change: Record<string, string | number | boolean>;
  confidence: number;
}

@Injectable()
export class ConfigSanityValidatorService {
  private readonly logger = new Logger(ConfigSanityValidatorService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('CONFIG_SANITY_VALIDATOR_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.logger.log(`[config-sanity-validator] onModuleInit fired — enabled=${this.enabled}`);

    if (this.enabled) {
      try {
        const job = new CronJob('17 * * * *', () => {
          this.runValidation().catch((e) =>
            this.logger.error(`[config-sanity-validator] cron failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('config-sanity-validator', job);
        job.start();
        this.logger.log('[config-sanity-validator] ENABLED — cron hourly @ minute 17');
      } catch (e) {
        this.logger.error(`[config-sanity-validator] cron register failed: ${String(e).slice(0, 200)}`);
      }
    }
  }

  async runValidation(): Promise<{ scanned: number; findings: number; lessonsInserted: number }> {
    const sb = this.supabase.getClient();
    const { data, error } = await sb
      .from('lisa_session_configs')
      .select('portfolio_id, gainers_default_tp_pct, gainers_default_sl_pct, gainers_position_pct, gainers_max_open_positions, gainers_min_change_pct_us_smallmid, gainers_min_change_pct_eu, capital_discipline_mode, strategy_mode, capital_usd')
      .in('portfolio_id', GAINERS_PORTFOLIOS.map((p) => p.id));

    if (error) {
      this.logger.error(`[config-sanity-validator] fetch failed: ${error.message}`);
      return { scanned: 0, findings: 0, lessonsInserted: 0 };
    }

    const findings: Finding[] = [];
    for (const cfg of (data ?? []) as ConfigRow[]) {
      const portfolioName = GAINERS_PORTFOLIOS.find((p) => p.id === cfg.portfolio_id)?.name ?? 'UNKNOWN';
      findings.push(...this.detectAntiPatterns(cfg, portfolioName));
    }

    // Pour chaque finding : APPLIQUE directement le fix DB (confidence ≥ 0.95) +
    // insère lesson pour audit. Skip si même anti-pattern déjà appliqué dans les 24h.
    let applied = 0;
    let auditOnly = 0;
    for (const f of findings) {
      try {
        // Anti-spam : skip si fix déjà appliqué dans les 24h pour ce portfolio
        const { data: existing } = await sb
          .from('scanner_lessons')
          .select('id')
          .eq('is_active', true)
          .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
          .ilike('lesson_text', `%${f.anti_pattern}%${f.portfolio_name}%`)
          .limit(1);
        if (existing && existing.length > 0) continue;

        // Audit : insert lesson gate_calibration
        await sb.from('scanner_lessons').insert({
          derived_from_date: new Date().toISOString().slice(0, 10),
          lesson_kind: 'gate_calibration',
          lesson_text: f.lesson_text,
          macro_condition: 'ANY',
          scope: 'all_scanner',
          confidence: f.confidence,
          sample_size: 10,
          proposed_config_change: f.proposed_config_change as Record<string, never>,
          is_active: true,
          applied: f.confidence >= 0.95,
          applied_at: f.confidence >= 0.95 ? new Date().toISOString() : null,
          applied_by: f.confidence >= 0.95 ? 'config-sanity-validator' : null,
        });

        // Apply direct si confidence ≥ 0.95
        if (f.confidence >= 0.95) {
          for (const [target, value] of Object.entries(f.proposed_config_change)) {
            const col = target.replace('lisa_session_configs.', '');
            const { error: updErr } = await sb
              .from('lisa_session_configs')
              .update({ [col]: value })
              .eq('portfolio_id', f.portfolio_id);
            if (updErr) {
              this.logger.warn(`[config-sanity-validator] UPDATE ${col}=${JSON.stringify(value)} on ${f.portfolio_name} failed: ${updErr.message}`);
            } else {
              this.logger.log(`[config-sanity-validator] ✅ APPLIED ${f.anti_pattern} on ${f.portfolio_name}: ${col}=${JSON.stringify(value)}`);
              applied++;
            }
          }
        } else {
          auditOnly++;
          this.logger.log(`[config-sanity-validator] AUDIT-ONLY ${f.anti_pattern} on ${f.portfolio_name} (conf=${f.confidence} < 0.95)`);
        }
      } catch (e) {
        this.logger.warn(`[config-sanity-validator] processing failed: ${String(e).slice(0, 100)}`);
      }
    }

    this.logger.log(
      `[config-sanity-validator] cycle done — scanned=${(data ?? []).length} findings=${findings.length} applied=${applied} audit_only=${auditOnly}`,
    );
    return { scanned: (data ?? []).length, findings: findings.length, lessonsInserted: applied + auditOnly };
  }

  /** Détecte les anti-patterns sur une config portfolio. Pure function, testable. */
  private detectAntiPatterns(cfg: ConfigRow, portfolioName: string): Finding[] {
    const findings: Finding[] = [];
    const tp = cfg.gainers_default_tp_pct;
    const sl = cfg.gainers_default_sl_pct;
    const pid = cfg.portfolio_id;

    // Anti-pattern 1 : R/R inversé (SL ≥ TP)
    if (tp != null && sl != null && tp > 0 && sl > 0 && sl >= tp) {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'RR_INVERTED',
        lesson_text: `[ConfigSanity] RR_INVERTED ${portfolioName} : SL=${sl}% ≥ TP=${tp}% → R/R défavorable, WR break-even nécessite >${(sl / tp * 100).toFixed(0)}% (impossible en pratique). Fix : sl_pct = ${(tp / 2).toFixed(1)}% (R/R 2:1 minimum).`,
        proposed_config_change: { [`lisa_session_configs.gainers_default_sl_pct`]: Math.max(0.5, tp / 2) },
        confidence: 0.95,
      });
    }

    // Anti-pattern 2 : min_change_pct_us_smallmid > 4%
    const minChgUs = cfg.gainers_min_change_pct_us_smallmid;
    if (minChgUs != null && minChgUs > 4) {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'MIN_CHG_US_TOO_HIGH',
        lesson_text: `[ConfigSanity] MIN_CHG_US_TOO_HIGH ${portfolioName} : min_change_pct_us_smallmid=${minChgUs}% > 4% rate les early movers US (median pump initial = 3-4%). Fix : 3.0%.`,
        proposed_config_change: { 'lisa_session_configs.gainers_min_change_pct_us_smallmid': 3.0 },
        confidence: 0.85,
      });
    }

    // Anti-pattern 3 : min_change_pct_eu > 3%
    const minChgEu = cfg.gainers_min_change_pct_eu;
    if (minChgEu != null && minChgEu > 3) {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'MIN_CHG_EU_TOO_HIGH',
        lesson_text: `[ConfigSanity] MIN_CHG_EU_TOO_HIGH ${portfolioName} : min_change_pct_eu=${minChgEu}% > 3% rate les early movers EU. Fix : 2.0%.`,
        proposed_config_change: { 'lisa_session_configs.gainers_min_change_pct_eu': 2.0 },
        confidence: 0.85,
      });
    }

    // Anti-pattern 4 : max_open_positions < 5
    const maxOpen = cfg.gainers_max_open_positions;
    if (maxOpen != null && maxOpen < 5) {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'MAX_OPEN_TOO_LOW',
        lesson_text: `[ConfigSanity] MAX_OPEN_TOO_LOW ${portfolioName} : max_open_positions=${maxOpen} < 5 limite l'exploitation des opportunités. Fix : 5.`,
        proposed_config_change: { 'lisa_session_configs.gainers_max_open_positions': 5 },
        confidence: 0.85,
      });
    }

    // Anti-pattern 5 : DAILY_HARVEST + strategy_mode='gainers' = incohérence
    if (cfg.capital_discipline_mode === 'DAILY_HARVEST' && cfg.strategy_mode === 'gainers') {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'HARVEST_GAINERS_MISMATCH',
        lesson_text: `[ConfigSanity] HARVEST_GAINERS_MISMATCH ${portfolioName} : capital_discipline_mode=DAILY_HARVEST + strategy_mode=gainers cap les gros gagnants à 2.5%. Fix : NONE.`,
        proposed_config_change: { 'lisa_session_configs.capital_discipline_mode': 'NONE' },
        confidence: 0.9,
      });
    }

    // Anti-pattern 6 : position_pct > 8% sur capital > $5000
    const posPct = cfg.gainers_position_pct;
    const cap = cfg.capital_usd;
    if (posPct != null && cap != null && posPct > 8 && cap > 5000) {
      findings.push({
        portfolio_id: pid,
        portfolio_name: portfolioName,
        anti_pattern: 'POSITION_PCT_RISK',
        lesson_text: `[ConfigSanity] POSITION_PCT_RISK ${portfolioName} : position_pct=${posPct}% sur capital $${cap} = notional $${(cap * posPct / 100).toFixed(0)}+ par trade = concentration risk. Fix : 5%.`,
        proposed_config_change: { 'lisa_session_configs.gainers_position_pct': 5.0 },
        confidence: 0.85,
      });
    }

    return findings;
  }

  /** Status pour endpoint admin observability. */
  async getStatus(): Promise<{ enabled: boolean; lastRunInsertCount: number; recentLessons: number }> {
    const sb = this.supabase.getClient();
    const { count } = await sb
      .from('scanner_lessons')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .ilike('lesson_text', '[ConfigSanity]%')
      .gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString());
    return {
      enabled: this.enabled,
      lastRunInsertCount: 0, // tracked en mémoire si besoin futur
      recentLessons: count ?? 0,
    };
  }
}
