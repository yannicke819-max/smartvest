import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { markOption } from '@smartvest/options';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';

/**
 * OptionBrokerService — paper-broker pour positions options.
 *
 * Tient le miroir simulé des positions options dans `lisa_option_positions`.
 * Mark-to-market via Black-Scholes (defaultIv constante par position).
 *
 * Limites actuelles (foundation) :
 *  - Long only (calls et puts achetés). Short = chantier ultérieur.
 *  - IV figée à l'ouverture (pas de surface dynamique).
 *  - Pas de slippage ni spread modélisés (BS = théorique).
 *  - Fees broker fixes (10 bps sur le notional premium).
 */

export interface OpenOptionInput {
  portfolioId: string;
  proposalId?: string | null;
  thesisId?: string | null;
  underlying: string;
  assetClass: string;
  kind: 'call' | 'put';
  strike: number;
  /** YYYY-MM-DD */
  expiry: string;
  /** Premium target (USD) — détermine combien de contrats acheter. */
  premiumTargetUsd: number;
  underlyingPrice: number;
  iv: number;
  convictionScore?: number;
  source?: 'lisa' | 'mechanical';
}

export interface OptionPositionRow {
  id: string;
  portfolio_id: string;
  underlying: string;
  asset_class: string;
  kind: 'call' | 'put';
  strike: number;
  expiry: string;
  contracts: number;
  premium_paid_usd: number;
  entry_underlying_price: number;
  entry_iv: number;
  status: string;
  conviction_score: number | null;
}

const FEE_BPS = 10;

@Injectable()
export class OptionBrokerService {
  private readonly logger = new Logger(OptionBrokerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
  ) {}

  /**
   * Ouvre une position option : pricer BS détermine le premium par contrat,
   * puis on achète autant de contrats qu'on peut avec premiumTargetUsd.
   * Échoue silencieusement (return null) si le contrat est trop cher pour
   * acheter ne serait-ce qu'un contrat.
   */
  async openOption(input: OpenOptionInput): Promise<OptionPositionRow | null> {
    const today = new Date().toISOString().slice(0, 10);

    const oneContract = markOption({
      spot: input.underlyingPrice,
      strike: input.strike,
      expiryDate: input.expiry,
      asOfDate: today,
      iv: input.iv,
      kind: input.kind,
      contracts: 1,
      premiumPaid: 0,
    });

    if (oneContract.totalValueUsd <= 0) {
      this.logger.warn(
        `[option-broker] Open refusé ${input.kind} ${input.underlying}: premium 0 (probablement deep OTM ou expiry passée)`,
      );
      return null;
    }

    const contracts = Math.floor(input.premiumTargetUsd / oneContract.totalValueUsd);
    if (contracts < 1) {
      this.logger.warn(
        `[option-broker] Open refusé ${input.kind} ${input.underlying}: premium target $${input.premiumTargetUsd} < 1 contrat ($${oneContract.totalValueUsd.toFixed(2)})`,
      );
      return null;
    }

    const premiumPaid = oneContract.totalValueUsd * contracts;
    const fee = premiumPaid * (FEE_BPS / 10_000);

    const id = randomUUID();
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_option_positions')
      .insert({
        id,
        portfolio_id: input.portfolioId,
        proposal_id: input.proposalId ?? null,
        thesis_id: input.thesisId ?? null,
        underlying: input.underlying,
        asset_class: input.assetClass,
        kind: input.kind,
        direction: 'long',
        strike: input.strike,
        expiry: input.expiry,
        contracts,
        entry_underlying_price: input.underlyingPrice,
        entry_iv: input.iv,
        premium_paid_usd: premiumPaid,
        entry_fee_usd: fee,
        conviction_score: input.convictionScore ?? null,
        source: input.source ?? 'lisa',
      })
      .select('*')
      .single();

    if (error) {
      this.logger.warn(`[option-broker] Insert failed ${input.kind} ${input.underlying}: ${error.message}`);
      return null;
    }
    this.logger.log(
      `[option-broker] Opened ${input.kind} ${input.underlying} K=${input.strike.toFixed(2)} exp=${input.expiry} contracts=${contracts} premium=$${premiumPaid.toFixed(2)}`,
    );
    return data as OptionPositionRow;
  }

  /**
   * Liste les positions options ouvertes pour un portfolio.
   */
  async getOpenOptions(portfolioId: string): Promise<OptionPositionRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('lisa_option_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[option-broker] getOpenOptions failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as OptionPositionRow[];
  }

  /**
   * Mark-to-market d'une position option à un prix sous-jacent donné.
   * Retourne mark + P&L latent. Pas d'écriture DB.
   */
  markOption(
    pos: OptionPositionRow,
    currentUnderlyingPrice: number,
    asOfDate: string = new Date().toISOString().slice(0, 10),
  ): { value: number; pnlUsd: number; pnlPct: number; delta: number } {
    const m = markOption({
      spot: currentUnderlyingPrice,
      strike: Number(pos.strike),
      expiryDate: pos.expiry,
      asOfDate,
      iv: Number(pos.entry_iv),
      kind: pos.kind,
      contracts: Number(pos.contracts),
      premiumPaid: Number(pos.premium_paid_usd),
    });
    const pnlPct =
      pos.premium_paid_usd > 0 ? (m.pnlUsd / Number(pos.premium_paid_usd)) * 100 : 0;
    return { value: m.totalValueUsd, pnlUsd: m.pnlUsd, pnlPct, delta: m.delta };
  }

  /**
   * Ferme une option : mark au prix courant, débite fee, calcul P&L,
   * met à jour la ligne en DB.
   */
  async closeOption(
    positionId: string,
    currentUnderlyingPrice: number,
    reason: 'closed_expired' | 'closed_target' | 'closed_stop' | 'closed_invalidated',
  ): Promise<void> {
    const { data: pos } = await this.supabase
      .getClient()
      .from('lisa_option_positions')
      .select('*')
      .eq('id', positionId)
      .eq('status', 'open')
      .maybeSingle();

    if (!pos) return;

    const today = new Date().toISOString().slice(0, 10);
    const m = markOption({
      spot: currentUnderlyingPrice,
      strike: Number(pos.strike),
      expiryDate: pos.expiry as string,
      asOfDate: today,
      iv: Number(pos.entry_iv),
      kind: pos.kind as 'call' | 'put',
      contracts: Number(pos.contracts),
      premiumPaid: Number(pos.premium_paid_usd),
    });

    const exitFee = m.totalValueUsd * (FEE_BPS / 10_000);
    const proceeds = m.totalValueUsd - exitFee;
    const pnlUsd = proceeds - Number(pos.premium_paid_usd);
    const pnlPct =
      pos.premium_paid_usd > 0 ? (pnlUsd / Number(pos.premium_paid_usd)) * 100 : 0;

    await this.supabase
      .getClient()
      .from('lisa_option_positions')
      .update({
        status: reason,
        exit_underlying_price: currentUnderlyingPrice,
        exit_value_usd: m.totalValueUsd,
        exit_fee_usd: exitFee,
        exit_timestamp: new Date().toISOString(),
        realized_pnl_usd: pnlUsd,
        realized_pnl_pct: pnlPct,
        updated_at: new Date().toISOString(),
      })
      .eq('id', positionId);

    this.logger.log(
      `[option-broker] Closed ${pos.kind} ${pos.underlying} reason=${reason} P&L=$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
    );
  }

  /**
   * Cron toutes les 5 min : ferme automatiquement les options expirées et
   * celles atteignant le take-profit (×2 premium). Tourne 24/7 — les options
   * expirent même la nuit / weekend.
   */
  @Cron('0 */5 * * * *', { name: 'option-broker-expire-tp', timeZone: 'UTC' })
  async runExpireAndTakeProfit(): Promise<void> {
    const { data: opens, error } = await this.supabase
      .getClient()
      .from('lisa_option_positions')
      .select('*')
      .eq('status', 'open');
    if (error) {
      this.logger.warn(`[option-broker] cron list failed: ${error.message}`);
      return;
    }
    const todayDate = new Date().toISOString().slice(0, 10);
    let expired = 0;
    let tpHit = 0;
    for (const opt of (opens ?? []) as OptionPositionRow[]) {
      try {
        const quote = await this.lisa.getLivePrice(opt.underlying).catch(() => null);
        // 🛡️ Bug #M Part 3 (#C3) — garde fallback : si le quote est corrompu
        // (source fallback, NaN, ≤0) un spot=0 produirait intrinsic=0 → option
        // fermée à valeur nulle = perte totale du premium.
        const isFallback = quote != null && quote.source != null && quote.source.startsWith('fallback');
        const priceNum = quote != null ? parseFloat(quote.price) : NaN;
        const reliable = quote != null && !isFallback && Number.isFinite(priceNum) && priceNum > 0;
        // Pour l'expiration : spot fiable sinon entry_underlying_price (meilleur
        // que 0 — l'option DOIT être fermée car expirée, on ne peut pas skip).
        const spot = reliable ? priceNum : Number(opt.entry_underlying_price);
        if (todayDate >= opt.expiry) {
          await this.closeOption(opt.id, spot, 'closed_expired');
          expired++;
          continue;
        }
        // Pour le TP : skip ce cycle si pas de prix fiable (l'option reste
        // vivante, ré-évaluée au prochain cron quand un prix fiable arrive).
        if (!reliable) {
          this.logger.warn(
            `[FALLBACK_GUARD] option ${opt.id} (${opt.underlying}) TP check skip — source=${quote?.source ?? 'no_quote'}`,
          );
          continue;
        }
        // TP ×2 premium ?
        const m = this.markOption(opt, spot, todayDate);
        if (m.value >= Number(opt.premium_paid_usd) * 2) {
          await this.closeOption(opt.id, spot, 'closed_target');
          tpHit++;
        }
      } catch (e) {
        this.logger.warn(`[option-broker] cron close failed for ${opt.id}: ${String(e)}`);
      }
    }
    if (expired + tpHit > 0) {
      this.logger.log(`[option-broker] cron : ${expired} expired, ${tpHit} take-profit hit`);
    }
  }
}
