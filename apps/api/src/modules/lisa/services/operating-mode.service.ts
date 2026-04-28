/**
 * P7-MODE-GAINERS-BADGE — Service unifié 3-modes opératoires.
 *
 * `lisa_session_configs.strategy_mode` est la source de vérité du badge UI :
 *
 *   - 'investment' : pipeline Lisa LLM, profile long_term_investor, NONE,
 *                    stops larges (preset INVESTMENT)
 *   - 'harvest'    : pipeline Lisa LLM + DAILY_HARVEST, profile hyper_active,
 *                    stops serrés, sweep auto (preset HARVEST)
 *   - 'gainers'    : scanner momentum 24/7 déterministe, bypass LLM,
 *                    autopilot_enabled forcé
 *
 * Bascule investment/harvest = délègue à MacroModeService.applyMacroMode()
 * pour appliquer le preset complet (profile + capital_discipline_mode +
 * risk_constraints + autopilot_aggressive). En plus, on écrit strategy_mode
 * pour que le badge reflète l'état.
 *
 * Bascule gainers = on écrit strategy_mode='gainers' + autopilot_enabled=true
 * + kill_switch_active=false (sinon le scanner exit early). On ne touche
 * PAS au profile / capital_discipline_mode / risk_constraints — l'utilisateur
 * peut revenir à son mode précédent en re-cliquant sans perdre ses presets.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { MacroModeService } from './macro-mode.service';

export type OperatingMode = 'investment' | 'harvest' | 'gainers';

export const OPERATING_MODES: readonly OperatingMode[] = [
  'investment',
  'harvest',
  'gainers',
] as const;

export const MIN_CAPITAL_FOR_GAINERS_USD = 1000;

@Injectable()
export class OperatingModeService {
  private readonly logger = new Logger(OperatingModeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly macroMode: MacroModeService,
  ) {}

  /**
   * Lecture directe : retourne strategy_mode tel que stocké en DB.
   * Le badge UI affiche cette valeur comme « actif ».
   */
  async getMode(portfolioId: string): Promise<OperatingMode> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('strategy_mode')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    if (error) {
      throw new Error(`Lecture strategy_mode échouée: ${error.message}`);
    }
    const raw = (data?.strategy_mode as string | null) ?? 'investment';
    return this.normalize(raw);
  }

  /**
   * Applique un mode + side-effects + audit log.
   * Idempotent : ré-appelable avec le mode courant sans erreur.
   *
   * @throws BadRequestException si capital insuffisant pour 'gainers'.
   */
  async applyMode(
    userId: string,
    portfolioId: string,
    mode: OperatingMode,
    opts: { userAgent?: string | undefined; reason?: string | undefined } = {},
  ): Promise<{ mode: OperatingMode; previousMode: OperatingMode }> {
    const previousMode = await this.getMode(portfolioId);

    const capital = await this.fetchCapital(portfolioId);

    if (mode === 'gainers') {
      if (capital == null || capital < MIN_CAPITAL_FOR_GAINERS_USD) {
        throw new BadRequestException(
          `Capital insuffisant pour Gainers (min $${MIN_CAPITAL_FOR_GAINERS_USD}, current $${(capital ?? 0).toFixed(2)})`,
        );
      }
    }

    if (mode === 'investment' || mode === 'harvest') {
      // Applique le preset macro complet (profile + capital_discipline_mode
      // + risk_constraints + autopilot_aggressive).
      await this.macroMode.applyMacroMode(
        userId,
        portfolioId,
        mode === 'investment' ? 'INVESTMENT' : 'HARVEST',
      );
      // Le preset MacroMode ne touche pas strategy_mode — on l'écrit ici.
      await this.writeStrategyMode(userId, portfolioId, mode);
    } else {
      // gainers : autopilot_enabled forcé, kill-switch désarmé. Profile
      // et capital_discipline_mode préservés.
      await this.writeStrategyMode(userId, portfolioId, 'gainers', {
        autopilot_enabled: true,
        kill_switch_active: false,
      });
    }

    await this.writeAuditLog({
      userId,
      portfolioId,
      previousMode,
      newMode: mode,
      capitalUsd: capital,
      userAgent: opts.userAgent,
      reason: opts.reason,
    });

    this.logger.log(
      `[OPERATING_MODE] portfolio=${portfolioId.slice(0, 8)} ${previousMode} → ${mode}`,
    );

    return { mode, previousMode };
  }

  private normalize(raw: string): OperatingMode {
    return raw === 'harvest' || raw === 'gainers' ? raw : 'investment';
  }

  private async writeStrategyMode(
    userId: string,
    portfolioId: string,
    strategyMode: OperatingMode,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .update({
        strategy_mode: strategyMode,
        ...extra,
        updated_at: new Date().toISOString(),
      })
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId);
    if (error) {
      throw new Error(`Update strategy_mode failed: ${error.message}`);
    }
  }

  private async fetchCapital(portfolioId: string): Promise<number | null> {
    const { data } = await this.supabase
      .getClient()
      .from('lisa_session_configs')
      .select('capital_usd')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();
    if (!data) return null;
    const n = parseFloat(String(data.capital_usd ?? '0'));
    return Number.isFinite(n) ? n : null;
  }

  private async writeAuditLog(args: {
    userId: string;
    portfolioId: string;
    previousMode: OperatingMode;
    newMode: OperatingMode;
    capitalUsd: number | null;
    userAgent?: string | undefined;
    reason?: string | undefined;
  }): Promise<void> {
    const { error } = await this.supabase.getClient().from('mode_change_log').insert({
      portfolio_id: args.portfolioId,
      user_id: args.userId,
      old_mode: args.previousMode,
      new_mode: args.newMode,
      capital_usd: args.capitalUsd != null ? String(args.capitalUsd) : null,
      user_agent: args.userAgent ?? null,
      reason: args.reason ?? null,
    });
    if (error) {
      // Best effort : ne pas bloquer le toggle si l'audit échoue.
      this.logger.warn(
        `[OPERATING_MODE] audit log insert failed: ${error.message.slice(0, 160)}`,
      );
    }
  }
}
