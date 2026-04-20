import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import type { CreateMandateDto, UpdateMandateDto } from '../dto/mandate.dto';

type MandateAuditKind =
  | 'mandate_created'
  | 'mandate_activated'
  | 'mandate_suspended'
  | 'mandate_revoked'
  | 'kill_switch_triggered'
  | 'kill_switch_released';

@Injectable()
export class MandatesService {
  constructor(private readonly supabase: SupabaseService) {}

  async listMandates(userId: string, portfolioId?: string) {
    let q = this.supabase.getClient()
      .from('autonomy_mandates')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (portfolioId) q = q.eq('portfolio_id', portfolioId);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async getMandate(id: string, userId: string) {
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Mandat introuvable');
    return data;
  }

  async createMandate(userId: string, dto: CreateMandateDto) {
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .insert({
        id: uuid(),
        portfolio_id: dto.portfolioId,
        user_id: userId,
        label: dto.label,
        status: 'pending_activation',
        max_position_size_pct: dto.maxPositionSizePct,
        max_single_trade_pct: dto.maxSingleTradePct,
        max_daily_trade_pct: dto.maxDailyTradePct,
        max_single_trade_notional: dto.maxSingleTradeNotional ?? null,
        max_single_trade_notional_currency: dto.maxSingleTradeNotionalCurrency ?? null,
        allowed_asset_classes: dto.allowedAssetClasses,
        forbidden_tickers: dto.forbiddenTickers,
        requires_human_above_pct: dto.requiresHumanAbovePct,
        stop_loss_trigger_pct: dto.stopLossTriggerPct,
        max_open_positions: dto.maxOpenPositions ?? null,
        expires_at: dto.expiresAt,
        kill_switch_active: false,
      })
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Création impossible');
    await this.writeAuditEvent({
      portfolioId: dto.portfolioId,
      userId,
      mandateId: (data as Record<string, unknown>).id as string,
      kind: 'mandate_created',
      reason: `Mandat "${dto.label}" créé (en attente d'activation)`,
    });
    return data;
  }

  async updateMandate(id: string, userId: string, dto: UpdateMandateDto) {
    const existing = await this.getMandate(id, userId);
    if ((existing as Record<string, unknown>).status !== 'pending_activation') {
      throw new BadRequestException("Seul un mandat en attente d'activation peut être modifié");
    }
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.label !== undefined) updates['label'] = dto.label;
    if (dto.maxPositionSizePct !== undefined) updates['max_position_size_pct'] = dto.maxPositionSizePct;
    if (dto.maxSingleTradePct !== undefined) updates['max_single_trade_pct'] = dto.maxSingleTradePct;
    if (dto.maxDailyTradePct !== undefined) updates['max_daily_trade_pct'] = dto.maxDailyTradePct;
    if (dto.maxSingleTradeNotional !== undefined) updates['max_single_trade_notional'] = dto.maxSingleTradeNotional;
    if (dto.maxSingleTradeNotionalCurrency !== undefined) updates['max_single_trade_notional_currency'] = dto.maxSingleTradeNotionalCurrency;
    if (dto.allowedAssetClasses !== undefined) updates['allowed_asset_classes'] = dto.allowedAssetClasses;
    if (dto.forbiddenTickers !== undefined) updates['forbidden_tickers'] = dto.forbiddenTickers;
    if (dto.requiresHumanAbovePct !== undefined) updates['requires_human_above_pct'] = dto.requiresHumanAbovePct;
    if (dto.stopLossTriggerPct !== undefined) updates['stop_loss_trigger_pct'] = dto.stopLossTriggerPct;
    if (dto.maxOpenPositions !== undefined) updates['max_open_positions'] = dto.maxOpenPositions;
    if (dto.expiresAt !== undefined) updates['expires_at'] = dto.expiresAt;

    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Mise à jour impossible');
    return data;
  }

  async activateMandate(id: string, userId: string) {
    const existing = await this.getMandate(id, userId) as Record<string, unknown>;
    if (existing['status'] !== 'pending_activation') {
      throw new BadRequestException("Seul un mandat en attente d'activation peut être activé");
    }
    // Enforce one active mandate per portfolio
    const { data: active } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .select('id')
      .eq('portfolio_id', existing['portfolio_id'] as string)
      .eq('status', 'active')
      .maybeSingle();
    if (active) {
      throw new BadRequestException('Un mandat actif existe déjà pour ce portefeuille — suspendez-le d\'abord');
    }
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .update({ status: 'active', activated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Activation impossible');
    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      mandateId: id,
      kind: 'mandate_activated',
      reason: `Mandat "${existing['label'] as string}" activé`,
    });
    return data;
  }

  async suspendMandate(id: string, userId: string, reason?: string) {
    const existing = await this.getMandate(id, userId) as Record<string, unknown>;
    if (existing['status'] !== 'active') {
      throw new BadRequestException('Seul un mandat actif peut être suspendu');
    }
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .update({ status: 'suspended', suspended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Suspension impossible');
    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      mandateId: id,
      kind: 'mandate_suspended',
      reason: reason ?? `Mandat "${existing['label'] as string}" suspendu`,
    });
    return data;
  }

  async revokeMandate(id: string, userId: string, reason?: string) {
    const existing = await this.getMandate(id, userId) as Record<string, unknown>;
    const status = existing['status'] as string;
    if (status === 'revoked') {
      throw new BadRequestException('Ce mandat est déjà révoqué');
    }
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Révocation impossible');
    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      mandateId: id,
      kind: 'mandate_revoked',
      reason: reason ?? `Mandat "${existing['label'] as string}" révoqué`,
    });
    return data;
  }

  async toggleKillSwitch(id: string, userId: string, activate: boolean, reason?: string) {
    const existing = await this.getMandate(id, userId) as Record<string, unknown>;
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .update({ kill_switch_active: activate, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Kill-switch impossible');
    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      mandateId: id,
      kind: activate ? 'kill_switch_triggered' : 'kill_switch_released',
      reason: reason ?? (activate
        ? `Kill-switch activé sur mandat "${existing['label'] as string}"`
        : `Kill-switch désactivé sur mandat "${existing['label'] as string}"`),
    });
    return data;
  }

  async killAll(userId: string, reason?: string) {
    const { data: active } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('kill_switch_active', false);
    if (!active || active.length === 0) return { affected: 0 };
    for (const mandate of active as Array<Record<string, unknown>>) {
      await this.supabase.getClient()
        .from('autonomy_mandates')
        .update({ kill_switch_active: true, updated_at: new Date().toISOString() })
        .eq('id', mandate['id'] as string)
        .eq('user_id', userId);
      await this.writeAuditEvent({
        portfolioId: mandate['portfolio_id'] as string,
        userId,
        mandateId: mandate['id'] as string,
        kind: 'kill_switch_triggered',
        reason: reason ?? `Arrêt d'urgence global — kill-switch activé sur "${mandate['label'] as string}"`,
      });
    }
    return { affected: active.length };
  }

  async getAuditEvents(portfolioId: string, userId: string, mandateId?: string) {
    let q = this.supabase.getClient()
      .from('autonomy_audit_events')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(100);
    if (mandateId) q = q.eq('mandate_id', mandateId);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  private async writeAuditEvent(params: {
    portfolioId: string;
    userId: string;
    mandateId: string;
    kind: MandateAuditKind;
    reason: string;
  }) {
    const { portfolioId, userId, mandateId, kind, reason } = params;
    const { data: prev } = await this.supabase.getClient()
      .from('autonomy_audit_events')
      .select('hash')
      .eq('portfolio_id', portfolioId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevHash = (prev as { hash: string } | null)?.hash ?? null;
    const eventId = uuid();
    const hash = createHash('sha256')
      .update(`${eventId}|${portfolioId}|${kind}|${reason}|${prevHash ?? ''}`)
      .digest('hex');
    await this.supabase.getClient().from('autonomy_audit_events').insert({
      id: eventId,
      portfolio_id: portfolioId,
      user_id: userId,
      mandate_id: mandateId,
      proposal_id: null,
      kind,
      delegation_mode: 'MANUAL_EXPLICIT',
      reason,
      prev_hash: prevHash,
      hash,
    });
  }
}
