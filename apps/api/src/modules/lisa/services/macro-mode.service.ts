import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import type { DailyHarvestConfig, CapitalDisciplineMode } from '../types/capital-discipline.types';

export type MacroMode = 'INVESTMENT' | 'HARVEST';

/**
 * MacroModeService — applique des presets "macro mode" sur la config Lisa.
 *
 * Simplifie l'UX en regroupant les 5 dimensions orthogonales du système
 * (DelegationMode, OperatingTempo, CapitalDisciplineMode, presets risque,
 * params avancés) sous 2 philosophies opérationnelles :
 *
 *   📈 INVESTMENT — buy-and-hold patient, long horizon
 *     - profile: long_term_investor
 *     - capital_discipline_mode: NONE
 *     - autopilot_aggressive: false
 *     - cycle_minutes: 60 (passif)
 *     - constraints: stops larges (3-5%), maxLeverage 1.0
 *     - Capital qui croît avec les positions, pas de sweep
 *
 *   🌾 HARVEST — discipline journalière, court horizon
 *     - profile: hyper_active
 *     - capital_discipline_mode: DAILY_HARVEST avec config par défaut
 *     - autopilot_aggressive: true
 *     - cycle_minutes: 20 (réactif)
 *     - constraints: stops serrés (1.5%), take-profit absolu 2.5% (modifiable)
 *     - Capital de travail fixe, profits sweepés vers vault
 *
 * Idempotent : ré-appelable, écrase la config existante. L'utilisateur peut
 * toujours modifier les paramètres "Avancé" après application du preset.
 */
@Injectable()
export class MacroModeService {
  private readonly logger = new Logger(MacroModeService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Détecte le mode courant d'un portfolio basé sur la config.
   * Retourne 'CUSTOM' si la config ne matche ni INVESTMENT ni HARVEST.
   */
  async detectMode(portfolioId: string): Promise<MacroMode | 'CUSTOM'> {
    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select('profile, capital_discipline_mode')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (!cfg) return 'CUSTOM';

    const profile = cfg.profile as string;
    const disciplineMode = (cfg.capital_discipline_mode as CapitalDisciplineMode) ?? 'NONE';

    // INVESTMENT : long_term_investor + NONE
    if (profile === 'long_term_investor' && disciplineMode === 'NONE') {
      return 'INVESTMENT';
    }

    // HARVEST : hyper_active + DAILY_HARVEST
    if (profile === 'hyper_active' && disciplineMode === 'DAILY_HARVEST') {
      return 'HARVEST';
    }

    return 'CUSTOM';
  }

  /**
   * Applique un preset macro mode sur la config session.
   * Préserve les paramètres avancés non-conflictuels (objectifs, capital_usd,
   * tags, etc.) — n'écrase QUE les paramètres qui définissent le mode.
   */
  async applyMacroMode(
    userId: string,
    portfolioId: string,
    mode: MacroMode,
  ): Promise<{ mode: MacroMode; appliedConfig: Record<string, unknown> }> {
    const config = mode === 'INVESTMENT'
      ? this.buildInvestmentPreset()
      : this.buildHarvestPreset();

    // Update partiel : ne touche que les champs du preset, préserve le reste
    const { error } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update({
        ...config,
        updated_at: new Date().toISOString(),
      })
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Apply macro mode failed: ${error.message}`);
    }

    this.logger.log(
      `[MACRO_MODE] portfolio=${portfolioId.slice(0, 8)} → ${mode}`,
    );

    return { mode, appliedConfig: config };
  }

  // ───────────────────────────────────────────────────────────────────
  // PRESETS
  // ───────────────────────────────────────────────────────────────────

  /**
   * Preset INVESTMENT — buy-and-hold patient, long horizon.
   */
  private buildInvestmentPreset(): Record<string, unknown> {
    return {
      profile: 'long_term_investor',
      capital_discipline_mode: 'NONE' as CapitalDisciplineMode,
      daily_harvest_config: null,
      autopilot_aggressive: false,
      autopilot_cycle_minutes: 60,
      anti_consensus_strength: 5,
      // Risk constraints classique buy-and-hold
      risk_constraints: {
        maxPositionSizePct: 25,
        maxOpenPositions: 8,
        maxExposurePerAssetClassPct: 50,
        maxDrawdown2DaysPct: 15,
        maxLeverage: 1.0,
        defaultStopLossPct: 4,                      // stops larges
        targetDeploymentPct: 90,                    // bien investi
        // Note : pas de takeProfitAbsolutePct — laisse courir
      },
      enable_leverage: false,
      // Préserve : capital_usd, base_currency, autopilot_enabled, autopilot_auto_approve,
      //           kill_switch_active, return_target_*, etc.
    };
  }

  /**
   * Preset HARVEST — discipline journalière, court horizon, sweep auto.
   */
  private buildHarvestPreset(): Record<string, unknown> {
    const dailyHarvestConfig: DailyHarvestConfig = {
      dailyTargetAmountUsd: null,
      dailyTargetPercent: 0.5,                     // 0.5% du working capital par jour
      workingCapitalBaseUsd: 10000,                // ajustable par user
      profitSweepMode: 'PER_TRADE',                // sweep dès trade gagnant
      stopTradingWhenTargetHit: true,              // discipline forte
      allowReentryAfterTargetHit: false,
      maxLossPerDayUsd: 200,
      maxTradesPerDay: 15,
      sessionStartTime: '09:00',
      sessionEndTime: '22:00',
      timezone: 'Europe/Paris',
      cooldownMinutesAfterClose: 5,
      // Phase 4 : take-profit absolu modifiable (défaut 2.5%)
      // Stocké aussi dans daily_harvest_config pour cohérence
      // takeProfitAbsolutePct n'est PAS dans le type officiel mais lu
      // dynamiquement par mechanical-trading
    };

    // Champ supplémentaire take-profit modifiable (extension pragmatique)
    const dailyHarvestConfigWithTP = {
      ...dailyHarvestConfig,
      takeProfitAbsolutePct: 2.5,                  // modifiable par user via UI
    } as DailyHarvestConfig & { takeProfitAbsolutePct: number };

    return {
      profile: 'hyper_active',
      capital_discipline_mode: 'DAILY_HARVEST' as CapitalDisciplineMode,
      daily_harvest_config: dailyHarvestConfigWithTP,
      autopilot_aggressive: true,
      autopilot_cycle_minutes: 7,                  // ultra-réactif (HARVEST scalping). Modifiable UI dans clamp [5, 60].
      anti_consensus_strength: 7,
      // Risk constraints serrés
      risk_constraints: {
        maxPositionSizePct: 20,
        maxOpenPositions: 6,
        maxExposurePerAssetClassPct: 35,
        maxDrawdown2DaysPct: 10,
        maxLeverage: 1.5,
        defaultStopLossPct: 1.5,                   // stops serrés
        targetDeploymentPct: 85,
      },
      enable_leverage: true,
      enable_derivatives: true,                    // options autorisées
    };
  }
}
