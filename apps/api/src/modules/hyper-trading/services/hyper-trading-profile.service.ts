import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { HyperTradingAuditService } from './hyper-trading-audit.service';
import { DEFAULT_HYPER_TRADING_GUARDRAIL, type HyperTradingGuardrail } from '@smartvest/domain';
import type { ConfigureHyperTradingDto, UpdateGuardrailDto } from '../dto/hyper-trading.dto';

type ProfileRow = Record<string, unknown> & {
  id: string;
  status: string;
  user_id: string;
  kill_switch_active: boolean;
  expires_at: string;
};

const TRANSITIONS: Record<string, Set<string>> = {
  draft: new Set(['active', 'archived']),
  active: new Set(['paused', 'killed', 'archived']),
  paused: new Set(['active', 'killed', 'archived']),
  killed: new Set(['archived']),
  archived: new Set(),
};

function snake(g: Partial<HyperTradingGuardrail>) {
  return {
    ...(g.maxTradesPerDay !== undefined && { max_trades_per_day: g.maxTradesPerDay }),
    ...(g.cooldownMinutesBetweenTrades !== undefined && { cooldown_minutes_between_trades: g.cooldownMinutesBetweenTrades }),
    ...(g.reviewEveryNMinutes !== undefined && { review_every_n_minutes: g.reviewEveryNMinutes }),
    ...(g.maxNotionalPerTradePct !== undefined && { max_notional_per_trade_pct: g.maxNotionalPerTradePct }),
    ...(g.maxDailyNotionalPct !== undefined && { max_daily_notional_pct: g.maxDailyNotionalPct }),
    ...(g.maxExposurePerInstrumentPct !== undefined && { max_exposure_per_instrument_pct: g.maxExposurePerInstrumentPct }),
    ...(g.maxExposurePerAssetClassPct !== undefined && { max_exposure_per_asset_class_pct: g.maxExposurePerAssetClassPct }),
    ...(g.maxExposurePerSectorPct !== undefined && { max_exposure_per_sector_pct: g.maxExposurePerSectorPct }),
    ...(g.maxNotionalPerTradeAbs !== undefined && { max_notional_per_trade_abs: g.maxNotionalPerTradeAbs }),
    ...(g.maxDailyNotionalAbs !== undefined && { max_daily_notional_abs: g.maxDailyNotionalAbs }),
    ...(g.notionalCurrency !== undefined && { notional_currency: g.notionalCurrency }),
    ...(g.maxOpenPositions !== undefined && { max_open_positions: g.maxOpenPositions }),
    ...(g.maxDailyLossPct !== undefined && { max_daily_loss_pct: g.maxDailyLossPct }),
    ...(g.maxIntradayDrawdownPct !== undefined && { max_intraday_drawdown_pct: g.maxIntradayDrawdownPct }),
    ...(g.mandatoryStopLossPct !== undefined && { mandatory_stop_loss_pct: g.mandatoryStopLossPct }),
    ...(g.optionalTakeProfitPct !== undefined && { optional_take_profit_pct: g.optionalTakeProfitPct }),
    ...(g.maximumAllowedSpreadBps !== undefined && { maximum_allowed_spread_bps: g.maximumAllowedSpreadBps }),
    ...(g.maximumAllowedSlippageBps !== undefined && { maximum_allowed_slippage_bps: g.maximumAllowedSlippageBps }),
    ...(g.minimumExpectedLiquidityAbs !== undefined && { minimum_expected_liquidity_abs: g.minimumExpectedLiquidityAbs }),
    ...(g.maxAcceptableVolatilityPct !== undefined && { max_acceptable_volatility_pct: g.maxAcceptableVolatilityPct }),
    ...(g.allowedAssetClasses !== undefined && { allowed_asset_classes: g.allowedAssetClasses }),
    ...(g.deniedTickers !== undefined && { denied_tickers: g.deniedTickers }),
    ...(g.requiredHumanApprovalAboveAbs !== undefined && { required_human_approval_above_abs: g.requiredHumanApprovalAboveAbs }),
    ...(g.killSwitchOnAbnormalLoss !== undefined && { kill_switch_on_abnormal_loss: g.killSwitchOnAbnormalLoss }),
    ...(g.killSwitchOnDataProviderFailure !== undefined && { kill_switch_on_data_provider_failure: g.killSwitchOnDataProviderFailure }),
    ...(g.killSwitchOnBrokerSyncMismatch !== undefined && { kill_switch_on_broker_sync_mismatch: g.killSwitchOnBrokerSyncMismatch }),
    ...(g.killSwitchOnVolatilityShock !== undefined && { kill_switch_on_volatility_shock: g.killSwitchOnVolatilityShock }),
  };
}

@Injectable()
export class HyperTradingProfileService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly audit: HyperTradingAuditService,
  ) {}

  async getCurrent(userId: string, portfolioId?: string | null) {
    const sb = this.supabase.getClient();
    let q = sb
      .from('hyper_trading_profiles')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(1);
    if (portfolioId !== undefined && portfolioId !== null) q = q.eq('portfolio_id', portfolioId);
    const { data, error } = await q.maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async getById(id: string, userId: string): Promise<ProfileRow> {
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_profiles')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Profil hyper-trading introuvable');
    return data as ProfileRow;
  }

  async getGuardrail(profileId: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_guardrails')
      .select('*')
      .eq('profile_id', profileId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async configure(userId: string, dto: ConfigureHyperTradingDto) {
    const sb = this.supabase.getClient();
    const profileId = uuid();
    const guardrail = { ...DEFAULT_HYPER_TRADING_GUARDRAIL, ...(dto.guardrail ?? {}) };

    const { data: profile, error } = await sb
      .from('hyper_trading_profiles')
      .insert({
        id: profileId,
        user_id: userId,
        portfolio_id: dto.portfolioId ?? null,
        mandate_id: dto.mandateId ?? null,
        status: 'draft',
        tempo: dto.tempo,
        risk_level: dto.riskLevel,
        delegation_mode: dto.delegationMode,
        window_timezone: dto.windowTimezone,
        expires_at: dto.expiresAt,
        kill_switch_active: false,
      })
      .select()
      .single();
    if (error || !profile) throw new BadRequestException(error?.message ?? 'Création impossible');

    await sb.from('hyper_trading_guardrails').insert({
      profile_id: profileId,
      user_id: userId,
      ...snake(guardrail),
    });

    await this.audit.write({
      userId,
      profileId,
      kind: 'profile_created',
      reason: `Profil hyper-trading créé (tempo: ${dto.tempo}, mode: ${dto.delegationMode})`,
      payload: { tempo: dto.tempo, delegationMode: dto.delegationMode, riskLevel: dto.riskLevel },
    });

    return profile;
  }

  async updateGuardrail(profileId: string, userId: string, dto: UpdateGuardrailDto) {
    const profile = await this.getById(profileId, userId);
    if (profile.status === 'archived') {
      throw new BadRequestException('Profil archivé — impossible de modifier les garde-fous');
    }
    const updates = snake(dto);
    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Aucun champ valide à mettre à jour');
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_guardrails')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('profile_id', profileId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    await this.audit.write({
      userId,
      profileId,
      kind: 'guardrail_updated',
      reason: `Garde-fous mis à jour (${Object.keys(updates).length} champ(s))`,
      payload: updates,
    });
    return data;
  }

  private async transition(
    profileId: string,
    userId: string,
    next: 'active' | 'paused' | 'killed' | 'archived',
    reason: string,
    extraFields: Record<string, unknown> = {},
  ) {
    const profile = await this.getById(profileId, userId);
    const allowed = TRANSITIONS[profile.status] ?? new Set();
    if (!allowed.has(next)) {
      throw new BadRequestException(
        `Transition interdite ${profile.status} → ${next}`,
      );
    }
    if (next === 'active' && new Date(profile.expires_at) <= new Date()) {
      throw new BadRequestException('Profil expiré — impossible d\'activer');
    }
    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = { status: next, updated_at: nowIso, ...extraFields };
    if (next === 'active' && profile.status === 'draft') updates.activated_at = nowIso;
    if (next === 'paused') updates.paused_at = nowIso;
    if (next === 'killed') {
      updates.killed_at = nowIso;
      updates.kill_switch_active = true;
    }
    if (next === 'archived') updates.archived_at = nowIso;

    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_profiles')
      .update(updates)
      .eq('id', profileId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);

    const auditKind =
      next === 'active' ? (profile.status === 'paused' ? 'profile_resumed' : 'profile_activated')
      : next === 'paused' ? 'profile_paused'
      : next === 'killed' ? 'profile_killed'
      : 'profile_archived';

    await this.audit.write({ userId, profileId, kind: auditKind, reason });
    return data;
  }

  activate(profileId: string, userId: string, reason = 'Activation manuelle') {
    return this.transition(profileId, userId, 'active', reason);
  }

  pause(profileId: string, userId: string, reason = 'Pause manuelle') {
    return this.transition(profileId, userId, 'paused', reason);
  }

  resume(profileId: string, userId: string, reason = 'Reprise manuelle') {
    return this.transition(profileId, userId, 'active', reason);
  }

  kill(profileId: string, userId: string, reason: string) {
    return this.transition(profileId, userId, 'killed', reason);
  }

  archive(profileId: string, userId: string, reason = 'Archivage') {
    return this.transition(profileId, userId, 'archived', reason);
  }

  async listWindows(profileId: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_windows')
      .select('*')
      .eq('profile_id', profileId)
      .eq('user_id', userId)
      .order('weekday')
      .order('start_local');
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async createWindow(
    profileId: string,
    userId: string,
    dto: { weekday: number; startLocal: string; endLocal: string },
  ) {
    await this.getById(profileId, userId);
    if (dto.startLocal >= dto.endLocal) {
      throw new BadRequestException('startLocal doit être strictement avant endLocal');
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_windows')
      .insert({
        profile_id: profileId,
        user_id: userId,
        weekday: dto.weekday,
        start_local: dto.startLocal,
        end_local: dto.endLocal,
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }
}
