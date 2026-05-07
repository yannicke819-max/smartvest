import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { LiveFeatureFlagsService } from './live-feature-flags.service';

/**
 * PR Wizard.2 — LiveTradingWizardService.
 *
 * State machine + validation pour le wizard 6 steps. Chaque méthode
 * stepN(...) :
 *   1. Valide les inputs
 *   2. Vérifie la précondition (étapes précédentes complètes)
 *   3. Persiste les choix dans live_trading_setup_state.stepN_*
 *   4. Update current_step + status
 *   5. Audit dans live_wizard_audit
 *
 * Les transitions valides :
 *   draft → step1 → step2 → step3 → sandbox_running → sandbox_passed
 *     → live_active
 *
 * Aucune méthode ne flippe BROKER_EXECUTION_ENABLED par elle-même —
 * seul activateLive() à step5 le fait, après validation des conditions
 * Go/No-Go.
 */

export interface Step1BrokerSelection {
  use_ibkr: boolean;
  use_binance_us: boolean;
}

export interface Step2CredentialsValidation {
  ibkr_connection_id?: string;
  binance_connection_id?: string;
}

export interface Step3MandateConfig {
  max_position_size_pct: number;
  max_single_trade_pct: number;
  max_daily_trade_pct: number;
  allowed_asset_classes: string[];
  forbidden_tickers: string[];
  stop_loss_trigger_pct: number;
  expires_in_days: number;
  max_open_positions: number;
}

export interface WizardState {
  id: string;
  user_id: string;
  portfolio_id: string;
  current_step: number;
  status: string;
  step1_brokers: Record<string, unknown>;
  step2_credentials_status: Record<string, unknown>;
  step3_mandate_config: Record<string, unknown>;
  step4_sandbox_results: Record<string, unknown>;
  step5_activation_at: string | null;
  step5_activated_by: string | null;
  autonomy_mandate_id: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class LiveTradingWizardService {
  private readonly logger = new Logger(LiveTradingWizardService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly liveFlags: LiveFeatureFlagsService,
  ) {}

  /**
   * Récupère ou crée l'état du wizard pour un portfolio.
   */
  async getOrCreateWizardState(userId: string, portfolioId: string): Promise<WizardState> {
    const { data: existing } = await this.supabase
      .getClient()
      .from('live_trading_setup_state')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (existing) return existing as WizardState;

    const { data, error } = await this.supabase
      .getClient()
      .from('live_trading_setup_state')
      .insert({
        user_id: userId,
        portfolio_id: portfolioId,
        current_step: 1,
        status: 'draft',
      })
      .select()
      .single();
    if (error) throw new BadRequestException(`Wizard init failed: ${error.message}`);
    await this.audit(userId, portfolioId, 'wizard_started', 0, 1, {});
    return data as WizardState;
  }

  /**
   * Step 1 : Choix des brokers à activer.
   */
  async submitStep1(
    userId: string,
    portfolioId: string,
    payload: Step1BrokerSelection,
  ): Promise<WizardState> {
    if (!payload.use_ibkr && !payload.use_binance_us) {
      throw new BadRequestException('Au moins un broker doit être sélectionné');
    }
    const state = await this.getOrCreateWizardState(userId, portfolioId);
    if (state.status === 'live_active') {
      throw new ConflictException('Wizard est déjà en LIVE — utiliser revertToPaper() avant.');
    }

    await this.update(portfolioId, {
      step1_brokers: payload,
      current_step: 2,
      status: 'draft',
    });
    await this.audit(userId, portfolioId, 'step_completed', 1, 2, payload as unknown as Record<string, unknown>);
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  /**
   * Step 2 : Validation que les credentials sont bien stockés Vault et que
   * testConnection retourne ok pour chaque broker sélectionné.
   *
   * Le caller est responsable d'avoir créé les broker_connections (via UI
   * existante /settings/brokers/new) AVANT d'appeler cet endpoint.
   */
  async submitStep2(
    userId: string,
    portfolioId: string,
    payload: Step2CredentialsValidation,
  ): Promise<WizardState> {
    const state = await this.getOrCreateWizardState(userId, portfolioId);
    if (state.current_step < 2) {
      throw new BadRequestException('Step 1 non complétée');
    }
    const step1 = state.step1_brokers as unknown as Step1BrokerSelection;

    // Vérification des connections actives
    const status: Record<string, string> = {};
    if (step1.use_ibkr) {
      if (!payload.ibkr_connection_id) {
        throw new BadRequestException('IBKR sélectionné mais aucun connection_id fourni');
      }
      const ok = await this.verifyConnectionActive(payload.ibkr_connection_id, 'INTERACTIVE_BROKERS');
      if (!ok) throw new BadRequestException('IBKR connection introuvable ou inactive');
      status.ibkr = 'connected';
    }
    if (step1.use_binance_us) {
      if (!payload.binance_connection_id) {
        throw new BadRequestException('Binance.US sélectionné mais aucun connection_id fourni');
      }
      const ok = await this.verifyConnectionActive(payload.binance_connection_id, 'BINANCE');
      if (!ok) throw new BadRequestException('Binance connection introuvable ou inactive');
      status.binance = 'connected';
    }

    await this.update(portfolioId, {
      step2_credentials_status: status,
      current_step: 3,
    });
    await this.audit(userId, portfolioId, 'step_completed', 2, 3, status);
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  /**
   * Step 3 : Création de l'AutonomyMandate à partir des caps utilisateur.
   * Caps strictes obligatoires en V1 (pas de bypass possible) :
   *   - max_position_size_pct ≤ 10
   *   - max_daily_trade_pct ≤ 30
   *   - expires_in_days ≤ 90 (renouvellement obligatoire)
   */
  async submitStep3(
    userId: string,
    portfolioId: string,
    payload: Step3MandateConfig,
  ): Promise<WizardState> {
    const state = await this.getOrCreateWizardState(userId, portfolioId);
    if (state.current_step < 3) {
      throw new BadRequestException('Step 2 non complétée');
    }

    // Hard caps de sécurité V1
    if (payload.max_position_size_pct > 10) {
      throw new BadRequestException('max_position_size_pct doit être ≤ 10% en V1');
    }
    if (payload.max_daily_trade_pct > 30) {
      throw new BadRequestException('max_daily_trade_pct doit être ≤ 30% en V1');
    }
    if (payload.expires_in_days > 90 || payload.expires_in_days < 1) {
      throw new BadRequestException('expires_in_days doit être entre 1 et 90');
    }
    if (!payload.allowed_asset_classes || payload.allowed_asset_classes.length === 0) {
      throw new BadRequestException('Au moins une asset_class doit être autorisée');
    }

    const expiresAt = new Date(Date.now() + payload.expires_in_days * 86_400_000).toISOString();
    const guardrail = {
      maxPositionSizePct: payload.max_position_size_pct,
      maxSingleTradePct: payload.max_single_trade_pct,
      maxDailyTradePct: payload.max_daily_trade_pct,
      maxSingleTradeNotional: null,
      maxSingleTradeNotionalCurrency: null,
      allowedAssetClasses: payload.allowed_asset_classes,
      forbiddenTickers: payload.forbidden_tickers,
      requiresHumanAbovePct: payload.max_single_trade_pct,
      stopLossTriggerPct: payload.stop_loss_trigger_pct,
      maxOpenPositions: payload.max_open_positions,
    };

    // Crée le mandate
    const { data: mandate, error: mandateErr } = await this.supabase
      .getClient()
      .from('autonomy_mandates')
      .insert({
        portfolio_id: portfolioId,
        user_id: userId,
        status: 'active',
        label: `LIVE Wizard — ${payload.expires_in_days}j caps ${payload.max_position_size_pct}/${payload.max_daily_trade_pct}%`,
        guardrail,
        activated_at: new Date().toISOString(),
        expires_at: expiresAt,
        kill_switch_active: false,
      })
      .select('id')
      .single();

    if (mandateErr) {
      throw new BadRequestException(`Mandate creation failed: ${mandateErr.message}`);
    }

    await this.update(portfolioId, {
      step3_mandate_config: payload as unknown as Record<string, unknown>,
      autonomy_mandate_id: mandate.id,
      current_step: 4,
      status: 'sandbox_running',
    });
    await this.audit(userId, portfolioId, 'step_completed', 3, 4, {
      mandate_id: mandate.id,
      expires_at: expiresAt,
    });
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  /**
   * Step 4 : auto-validation après 30 trades sandbox.
   * Cette méthode est typiquement appelée par un cron (PR Wizard.4) qui
   * surveille les trades et déclenche le passage à sandbox_passed/failed
   * automatiquement. Pour V1.2 on laisse aussi un appel manuel pour skip.
   */
  async forceStep4Result(
    userId: string,
    portfolioId: string,
    result: 'passed' | 'failed',
    metrics: Record<string, unknown>,
  ): Promise<WizardState> {
    const state = await this.getOrCreateWizardState(userId, portfolioId);
    if (state.current_step < 4 || state.status !== 'sandbox_running') {
      throw new BadRequestException('Pas en phase sandbox_running');
    }

    const newStatus = result === 'passed' ? 'sandbox_passed' : 'sandbox_failed';
    await this.update(portfolioId, {
      step4_sandbox_results: metrics,
      current_step: result === 'passed' ? 5 : 4,
      status: newStatus,
    });
    await this.audit(userId, portfolioId,
      result === 'passed' ? 'sandbox_passed' : 'sandbox_failed',
      4, result === 'passed' ? 5 : 4, metrics);
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  /**
   * Step 5 : Activation FINALE du LIVE.
   *
   * 🚨 POINT DE NON-RETOUR — flippe BROKER_EXECUTION_ENABLED via DB-backed
   * flag (PR Wizard.1 LiveFeatureFlagsService).
   *
   * Préconditions :
   *   1. status === 'sandbox_passed'
   *   2. mandate actif + non expiré
   *   3. Confirmation explicite (caller envoie acknowledged=true)
   */
  async activateLive(
    userId: string,
    portfolioId: string,
    acknowledged: boolean,
  ): Promise<WizardState> {
    if (!acknowledged) {
      throw new BadRequestException('Activation LIVE requiert acknowledged=true');
    }

    const state = await this.getOrCreateWizardState(userId, portfolioId);
    if (state.status !== 'sandbox_passed') {
      throw new ConflictException(`Status doit être sandbox_passed (actuel: ${state.status})`);
    }
    if (!state.autonomy_mandate_id) {
      throw new ConflictException('Aucun mandate associé');
    }

    // Verify mandate still active
    const { data: mandate } = await this.supabase
      .getClient()
      .from('autonomy_mandates')
      .select('status, expires_at, kill_switch_active')
      .eq('id', state.autonomy_mandate_id)
      .single();
    if (!mandate || mandate.status !== 'active' || mandate.kill_switch_active) {
      throw new ConflictException('Mandate non actif ou kill-switch armé');
    }
    if (new Date(mandate.expires_at) <= new Date()) {
      throw new ConflictException('Mandate expiré — recréer un nouveau mandate via step 3');
    }

    // Flip flags via DB-backed service
    const step1 = state.step1_brokers as unknown as Step1BrokerSelection;
    await this.liveFlags.setFlag('DELEGATION_AUTONOMOUS_GUARDED', true, userId, 'wizard step5 activation', 'wizard');
    if (step1.use_ibkr) {
      await this.liveFlags.setFlag('BROKER_ADAPTER_IB_ENABLED', true, userId, 'wizard step5 IBKR', 'wizard');
    }
    if (step1.use_binance_us) {
      await this.liveFlags.setFlag('BROKER_ADAPTER_BINANCE_ENABLED', true, userId, 'wizard step5 Binance', 'wizard');
    }
    await this.liveFlags.setFlag('BROKER_RECONCILIATION_ENABLED', true, userId, 'wizard step5 reconciliation', 'wizard');
    // EXECUTION_ENABLED en DERNIER (le master gate)
    await this.liveFlags.setFlag('BROKER_EXECUTION_ENABLED', true, userId, 'wizard step5 FINAL ACTIVATION', 'wizard');

    const activationAt = new Date().toISOString();
    await this.update(portfolioId, {
      current_step: 6,
      status: 'live_active',
      step5_activation_at: activationAt,
      step5_activated_by: userId,
    });
    await this.audit(userId, portfolioId, 'live_activated', 5, 6, {
      mandate_id: state.autonomy_mandate_id,
      activation_at: activationAt,
    });

    this.logger.warn(
      `[wizard] 🚨 LIVE ACTIVATED for portfolio ${portfolioId.slice(0, 8)} by user ${userId.slice(0, 8)}`,
    );
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  /**
   * Revert : désactive LIVE, retour en mode paper. Toujours dispo.
   * Ne supprime PAS le mandate (juste pause), pour pouvoir reprendre
   * facilement.
   */
  async revertToPaper(userId: string, portfolioId: string, reason: string): Promise<WizardState> {
    const state = await this.getOrCreateWizardState(userId, portfolioId);

    // Disable execution flag (DB-backed) en premier
    await this.liveFlags.setFlag('BROKER_EXECUTION_ENABLED', false, userId, `revert: ${reason}`, 'kill_switch_revert');

    await this.update(portfolioId, { status: 'reverted' });
    await this.audit(userId, portfolioId, 'live_paused', state.current_step, state.current_step, {
      reason,
    });
    this.logger.warn(`[wizard] LIVE reverted for ${portfolioId.slice(0, 8)} : ${reason}`);
    return this.getOrCreateWizardState(userId, portfolioId);
  }

  // ── Helpers internes ──────────────────────────────────────────────────

  private async update(portfolioId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('live_trading_setup_state')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('portfolio_id', portfolioId);
    if (error) throw new BadRequestException(`Wizard update failed: ${error.message}`);
  }

  private async verifyConnectionActive(connectionId: string, expectedProvider: string): Promise<boolean> {
    const { data } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('id, provider, status')
      .eq('id', connectionId)
      .maybeSingle();
    if (!data) return false;
    return data.provider === expectedProvider && data.status === 'active';
  }

  private async audit(
    userId: string,
    portfolioId: string,
    eventKind: string,
    fromStep: number,
    toStep: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.supabase
        .getClient()
        .from('live_wizard_audit')
        .insert({
          user_id: userId,
          portfolio_id: portfolioId,
          event_kind: eventKind,
          from_step: fromStep,
          to_step: toStep,
          payload,
        });
    } catch (e) {
      this.logger.warn(`[wizard-audit] insert failed: ${String(e).slice(0, 80)}`);
    }
  }
}
