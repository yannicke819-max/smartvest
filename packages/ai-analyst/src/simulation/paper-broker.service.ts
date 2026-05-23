/**
 * PaperBrokerService — Exécution SIMULÉE de positions
 *
 * Jamais d'ordre réel. Toutes les positions vivent en DB Supabase,
 * P&L calculé à partir des prix EODHD live.
 *
 * Respecte CLAUDE.md :
 *  - is_simulation=true requis sur portfolio
 *  - Aucune connexion broker live
 *  - Coûts simulés (frais, spread, slippage estimés)
 */

import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ClosePositionCommand,
  OpenPositionCommand,
  OpenPositionDirectCommand,
  PaperPosition,
  PortfolioSnapshot,
} from './types';
import { computeVenueFeeDetail, type VenueFeeBreakdown } from './venue-fees';

/**
 * P20 (30/04/2026) — Buffer multiplicatif fees → gain min requis pour ouvrir.
 *
 * Default 2.0 (= gain attendu au TP doit être ≥ 2× les fees round-trip).
 * Configurable via env `FEES_AWARE_BUFFER`, clamp [1.0, 5.0].
 *
 * Justification valeur : les 9 losses J-7 incluent un closed_target SLV
 * +0.171 % avec net -$0.92 — ratio gain/fees observé ~0.6×. Le seuil 2.0
 * laisse une marge confortable pour slippage 5bps non comptabilisé +
 * inflation des fees IBKR sur les petits volumes.
 */
export function resolveFeesAwareBuffer(): Decimal {
  const raw = process.env.FEES_AWARE_BUFFER;
  const DEFAULT_BUFFER = 2.0;
  if (!raw) return new Decimal(DEFAULT_BUFFER);
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) return new Decimal(DEFAULT_BUFFER);
  // Clamp [1.0, 5.0] : 1.0 = pas de buffer (juste break-even), 5.0 = très conservateur.
  const clamped = Math.max(1.0, Math.min(5.0, parsed));
  return new Decimal(clamped);
}

export interface PriceQuote {
  symbol: string;
  price: string;  // decimal
  asOf: string;
  source: string;
}

export interface PaperBrokerDeps {
  supabase: SupabaseClient;
  /** Callback pour fetch live prices — typiquement EODHD adapter */
  fetchLivePrice: (symbol: string) => Promise<PriceQuote>;
}

/**
 * P19u (29/04/2026) — Modèle de frais réaliste basé sur IBKR Pro Tiered.
 *
 * Le modèle précédent (`estimatedCostBps = 10`) facturait 10bps de la
 * notional sur chaque côté, soit **$5 round-trip sur $2500 = 0.20%**. C'est
 * **~100x trop cher** vs IBKR Pro réel ($0.005/share, min $0.35, capped 1%).
 *
 * Symptôme prod (29/04 ce soir) : 7 trades fermés all TP_HIT avec exit > entry,
 * gross calculé +$4.74, net affiché -$27.84 → écart de -$32.58 de fees
 * fictifs invisibles. Win rate = 0% car fees > gross PnL sur trades à
 * petit move (+0.03% à +0.21% TP).
 *
 * Modèle implémenté :
 *  - US equities + ETFs : `max($0.35, $0.005/share)` clamped à `1% × notional`
 *  - EU + Asia equities : 5bps × notional (proxy moyenne plans IBKR EU)
 *  - Crypto via Paxos    : 0.085% × notional (avg maker/taker)
 *  - FX                  : 1bp × notional
 *  - Default fallback    : 5bps × notional
 *
 * Hypothèse simplifiée : l'asset class drive tout, pas de tier IBKR exact
 * (le tier dépend du volume mensuel — non modelé en paper sim).
 */
export function computeRealisticFee(
  qty: Decimal,
  price: Decimal,
  assetClass: string | undefined,
): Decimal {
  const ac = (assetClass ?? '').toLowerCase();
  if (qty.lte(0) || price.lte(0)) return new Decimal(0);

  // Crypto via IBKR/Paxos — average 0.085% (maker-taker mix)
  if (ac.startsWith('crypto')) {
    return qty.mul(price).mul(0.00085);
  }
  // EU equities — 5bps proxy (réel IBKR EU varie par exchange + tier)
  if (ac === 'eu_equity') {
    return qty.mul(price).mul(0.0005);
  }
  // Asia equities — 5bps proxy
  if (ac === 'asia_equity') {
    return qty.mul(price).mul(0.0005);
  }
  // FX major / cross — typiquement 0.5-1bp ; on prend 1bp
  if (ac.startsWith('fx_')) {
    return qty.mul(price).mul(0.0001);
  }
  // Commodity / Rates — 5bps proxy
  if (ac === 'commodity' || ac === 'rates') {
    return qty.mul(price).mul(0.0005);
  }
  // Default — US equities + ETFs IBKR Pro Tiered :
  //   $0.005/share, min $0.35, max 1% of trade value
  const perShare = qty.mul(0.005);
  const minFee = new Decimal(0.35);
  const maxFee = qty.mul(price).mul(0.01);
  let fee = Decimal.max(perShare, minFee);
  if (fee.gt(maxFee)) fee = maxFee;
  return fee;
}

export class PaperBrokerService {
  private readonly supabase: SupabaseClient;
  private readonly fetchLivePrice: PaperBrokerDeps['fetchLivePrice'];

  constructor(deps: PaperBrokerDeps) {
    this.supabase = deps.supabase;
    this.fetchLivePrice = deps.fetchLivePrice;
  }

  /**
   * Ouvre une position simulée à partir d'une thèse approuvée.
   * Déduit le notional du cash disponible, enregistre la position.
   */
  async openPosition(cmd: OpenPositionCommand): Promise<PaperPosition> {
    const now = new Date().toISOString();

    // Récupérer la thèse depuis la proposal (pour symbol, direction, venue, coûts)
    const { data: proposal, error: pErr } = await this.supabase
      .from('lisa_proposals')
      .select('theses, capital_usd')
      .eq('id', cmd.proposalId)
      .single();
    if (pErr || !proposal) {
      throw new Error(`Proposal ${cmd.proposalId} not found`);
    }

    const theses = proposal.theses as Array<Record<string, unknown>>;
    const thesis = theses.find((t) => t.id === cmd.thesisId);
    if (!thesis) {
      throw new Error(`Thesis ${cmd.thesisId} not found in proposal`);
    }

    const expressions = thesis.expressions as Array<Record<string, unknown>>;
    const expression = expressions[cmd.expressionIndex];
    if (!expression) {
      throw new Error(`Expression index ${cmd.expressionIndex} out of bounds`);
    }

    // Calcul quantité : notional / price
    const livePrice = new Decimal(cmd.livePrice);
    const notional = new Decimal(cmd.capitalAllocationUsd);
    if (livePrice.isZero() || livePrice.isNegative()) {
      throw new Error(`Invalid live price: ${cmd.livePrice}`);
    }

    // Reject explicitement si notional sous-significatif (évite les positions
    // fantômes avec qty=0 et notional=0 affichés en UI). Symptôme observé
    // quand auto-approve appelle openPosition avec amountUsd<10 (cash épuisé).
    if (notional.lt(10)) {
      throw new Error(
        `openPosition rejected: notional ${notional.toFixed(2)} USD < 10 USD floor (insufficient sizing). symbol=${expression.symbol}`,
      );
    }

    // P19u — Calcul fee réaliste (IBKR Pro Tiered) au lieu du modèle bps fixe
    // de l'ancien code. Two-pass : qty tentative (no fee) → fee → qty finale.
    // P19x.8 (29/04/2026) — Capture aussi le breakdown JSON via computeVenueFeeDetail
    // pour persist en venue_fee_detail (UI tooltip).
    const tentativeQty = notional.dividedBy(livePrice);
    const entryFeeBreakdown = computeVenueFeeDetail(
      tentativeQty,
      livePrice,
      expression.assetClass as string | undefined,
      expression.preferredVenue as string | undefined,
      'buy',
    );
    const estimatedCost = new Decimal(entryFeeBreakdown.total);

    // Garde-fou : si le fee dépasse la notional (cas pathologique), reject.
    if (estimatedCost.gte(notional)) {
      throw new Error(
        `openPosition rejected: entry fee ${estimatedCost.toFixed(2)} >= notional ${notional.toFixed(2)} (symbol=${expression.symbol})`,
      );
    }

    // P20 (30/04/2026) — FEES-AWARE TARGET guard.
    // P20.2 (30/04/2026) — include slippage 5bps in roundTripFees calc.
    //
    // Bug observed J-7 (2026-04-23 → 2026-04-29) : 9 trades closed_target
    // avec pct_move POSITIF (+0.003 % à +0.171 %) mais P&L NÉGATIF (-$0.92
    // à -$5.67). Ex LMT @ $508, +0.019 % = +$0.10/share gross, fees
    // round-trip ~$5.77 → net -$5.67.
    //
    // Cause : le TP configuré (en %) est inférieur au coût round-trip en %
    // sur petits notionals. Le min commission IBKR ($0.35/side) + SEC fee
    // sell + TAF rendent le break-even à 0.15-0.40 % selon notional.
    //
    // P20.2 ajoute slippage 5bps (entry + exit) dans le calcul :
    //   roundTripFees = entry_venue_fees + entry_slippage_5bps
    //                 + exit_venue_fees  + exit_slippage_5bps
    // Cohérent avec mechanical-trading.closePosition qui charge slippageBps=5
    // au close. Évite que SLV +0.171 % qty=39 (gain $4.30 vs venue fees
    // $0.93 → ratio 4.6×) passe le guard alors que le slippage réel
    // ($1.26 entry + $1.26 exit = $2.52 add) le rend net négatif.
    //
    // Fix : reject l'open si gain attendu au TP < BUFFER × round-trip fees+slip.
    // Default BUFFER=2.0 (configurable via env FEES_AWARE_BUFFER, range
    // 1.0..5.0). Skip si pas de takeProfitPrice (Lisa narrative sans TP) —
    // le MIN_NET_PROFIT guard de mechanical-trading prend le relais au close.
    if (cmd.takeProfitPrice) {
      const tpPrice = new Decimal(cmd.takeProfitPrice);
      const tentativeQty = notional.dividedBy(livePrice);
      const direction = expression.direction as string;
      const isLong = direction === 'long' || direction.startsWith('long_');
      const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';
      const exitFeeBreakdown = computeVenueFeeDetail(
        tentativeQty,
        tpPrice,
        expression.assetClass as string | undefined,
        expression.preferredVenue as string | undefined,
        exitSide,
      );
      // P20.2 — slippage 5bps × notional sur chaque side. Cohérent avec
      // mechanical-trading.service.ts:1082 (entry) et :2087 (exit).
      const SLIPPAGE_BPS = 5;
      const entryNotional = tentativeQty.mul(livePrice);
      const exitNotional = tentativeQty.mul(tpPrice);
      const entrySlippage = entryNotional.mul(SLIPPAGE_BPS).div(10000);
      const exitSlippage = exitNotional.mul(SLIPPAGE_BPS).div(10000);
      const roundTripFees = estimatedCost
        .plus(new Decimal(exitFeeBreakdown.total))
        .plus(entrySlippage)
        .plus(exitSlippage);
      const expectedGain = isLong
        ? tpPrice.minus(livePrice).mul(tentativeQty)
        : livePrice.minus(tpPrice).mul(tentativeQty);

      const buffer = resolveFeesAwareBuffer();
      const requiredGain = roundTripFees.mul(buffer);

      if (expectedGain.lt(requiredGain)) {
        throw new Error(
          `openPosition rejected by P20 fees-aware guard: expected_gain_at_TP=$${expectedGain.toFixed(2)} ` +
          `< ${buffer.toFixed(2)} × round_trip_fees_with_slippage=$${requiredGain.toFixed(2)} ` +
          `(entry=$${livePrice.toFixed(4)} TP=$${tpPrice.toFixed(4)} qty=${tentativeQty.toFixed(4)} ` +
          `notional=$${notional.toFixed(2)} venue_fees=$${estimatedCost.plus(new Decimal(exitFeeBreakdown.total)).toFixed(2)} ` +
          `slippage_5bps_RT=$${entrySlippage.plus(exitSlippage).toFixed(2)} symbol=${expression.symbol}). ` +
          `Augmenter le TP ou le notional pour ouvrir cette position.`,
        );
      }
    }

    // Notional net après coût → quantité finale
    const notionalNet = notional.minus(estimatedCost);
    const quantity = notionalNet.dividedBy(livePrice);
    if (quantity.lte(0) || !quantity.isFinite()) {
      throw new Error(
        `openPosition rejected: invalid quantity ${quantity.toString()} (notional=${notional.toFixed(2)} price=${livePrice.toFixed(4)})`,
      );
    }

    const position: PaperPosition = {
      id: randomUUID(),
      portfolioId: cmd.portfolioId,
      proposalId: cmd.proposalId,
      thesisId: cmd.thesisId,
      symbol: expression.symbol as string,
      assetClass: expression.assetClass as string,
      direction: expression.direction as PaperPosition['direction'],
      venue: expression.preferredVenue as string,
      quantity: quantity.toFixed(10),
      entryPrice: livePrice.toFixed(10),
      entryTimestamp: now,
      entryNotionalUsd: notional.toFixed(2),
      status: 'open',
      exitPrice: null,
      exitTimestamp: null,
      exitReason: null,
      realizedPnlUsd: null,
      realizedPnlPct: null,
      stopLossPrice: cmd.stopLossPrice,
      takeProfitPrice: cmd.takeProfitPrice,
      horizonTargetDate: new Date(
        Date.now() + cmd.horizonDays * 86_400_000,
      ).toISOString(),
      estimatedEntryCostUsd: estimatedCost.toFixed(2),
      createdAt: now,
      updatedAt: now,
    };

    // Persist
    const { error: insErr } = await this.supabase.from('lisa_positions').insert({
      id: position.id,
      portfolio_id: position.portfolioId,
      proposal_id: position.proposalId,
      thesis_id: position.thesisId,
      symbol: position.symbol,
      asset_class: position.assetClass,
      direction: position.direction,
      venue: position.venue,
      quantity: position.quantity,
      entry_price: position.entryPrice,
      entry_timestamp: position.entryTimestamp,
      entry_notional_usd: position.entryNotionalUsd,
      status: position.status,
      stop_loss_price: position.stopLossPrice,
      take_profit_price: position.takeProfitPrice,
      horizon_target_date: position.horizonTargetDate,
      estimated_entry_cost_usd: position.estimatedEntryCostUsd,
      // P19x.8 — Real fees per venue persistence
      fees_in_usd: position.estimatedEntryCostUsd,
      venue_fee_detail: { entry: entryFeeBreakdown },
      created_at: position.createdAt,
      updated_at: position.updatedAt,
    });
    if (insErr) throw new Error(`Paper position insert failed: ${insErr.message}`);

    return position;
  }

  /**
   * PR #250 — Ouvre une position SANS passer par `lisa_proposals` ni `approveProposal`.
   *
   * Réservé au scanner Gainers déterministe : pas de thèse LLM, pas de
   * validation proposal, pas de re-fetch. Toutes les données nécessaires
   * arrivent inline via la commande. Latence ~250 ms vs 2-3 sec via le
   * pipeline LLM legacy.
   *
   * Garde-fous :
   *   - Notional floor 10 USD
   *   - Fees > notional reject
   *   - P20 fees-aware target guard (idem openPosition classique)
   *   - Quantity > 0 finite
   *
   * INSERT lisa_positions avec proposal_id=NULL et thesis_id=NULL (migration
   * 0120 rend ces colonnes nullable).
   */
  async openPositionDirect(cmd: OpenPositionDirectCommand): Promise<PaperPosition> {
    const now = new Date().toISOString();
    const livePrice = new Decimal(cmd.livePrice);
    const notional = new Decimal(cmd.capitalAllocationUsd);
    if (livePrice.isZero() || livePrice.isNegative()) {
      throw new Error(`Invalid live price: ${cmd.livePrice}`);
    }
    if (notional.lt(10)) {
      throw new Error(
        `openPositionDirect rejected: notional ${notional.toFixed(2)} USD < 10 USD floor (insufficient sizing). symbol=${cmd.symbol}`,
      );
    }

    const isLong = cmd.direction === 'long' || cmd.direction.startsWith('long_');

    // Two-pass : qty tentative (no fee) → fee → qty finale.
    const tentativeQty = notional.dividedBy(livePrice);
    const entryFeeBreakdown = computeVenueFeeDetail(
      tentativeQty,
      livePrice,
      cmd.assetClass,
      cmd.venue,
      'buy',
    );
    const estimatedCost = new Decimal(entryFeeBreakdown.total);
    if (estimatedCost.gte(notional)) {
      throw new Error(
        `openPositionDirect rejected: entry fee ${estimatedCost.toFixed(2)} >= notional ${notional.toFixed(2)} (symbol=${cmd.symbol})`,
      );
    }

    // P20 fees-aware target guard — identique à openPosition.
    if (cmd.takeProfitPrice) {
      const tpPrice = new Decimal(cmd.takeProfitPrice);
      const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';
      const exitFeeBreakdown = computeVenueFeeDetail(
        tentativeQty,
        tpPrice,
        cmd.assetClass,
        cmd.venue,
        exitSide,
      );
      const SLIPPAGE_BPS = 5;
      const entryNotional = tentativeQty.mul(livePrice);
      const exitNotional = tentativeQty.mul(tpPrice);
      const entrySlippage = entryNotional.mul(SLIPPAGE_BPS).div(10000);
      const exitSlippage = exitNotional.mul(SLIPPAGE_BPS).div(10000);
      const roundTripFees = estimatedCost
        .plus(new Decimal(exitFeeBreakdown.total))
        .plus(entrySlippage)
        .plus(exitSlippage);
      const expectedGain = isLong
        ? tpPrice.minus(livePrice).mul(tentativeQty)
        : livePrice.minus(tpPrice).mul(tentativeQty);
      const buffer = resolveFeesAwareBuffer();
      const requiredGain = roundTripFees.mul(buffer);
      if (expectedGain.lt(requiredGain)) {
        throw new Error(
          `openPositionDirect rejected by P20 fees-aware guard: expected_gain_at_TP=$${expectedGain.toFixed(2)} ` +
          `< ${buffer.toFixed(2)} × round_trip_fees_with_slippage=$${requiredGain.toFixed(2)} ` +
          `(entry=$${livePrice.toFixed(4)} TP=$${tpPrice.toFixed(4)} qty=${tentativeQty.toFixed(4)} ` +
          `notional=$${notional.toFixed(2)} symbol=${cmd.symbol}).`,
        );
      }
    }

    // Notional net après coût → quantité finale
    const notionalNet = notional.minus(estimatedCost);
    const quantity = notionalNet.dividedBy(livePrice);
    if (quantity.lte(0) || !quantity.isFinite()) {
      throw new Error(
        `openPositionDirect rejected: invalid quantity ${quantity.toString()} (notional=${notional.toFixed(2)} price=${livePrice.toFixed(4)})`,
      );
    }

    const position: PaperPosition = {
      id: randomUUID(),
      portfolioId: cmd.portfolioId,
      proposalId: null,
      thesisId: null,
      symbol: cmd.symbol,
      assetClass: cmd.assetClass,
      direction: cmd.direction,
      venue: cmd.venue,
      quantity: quantity.toFixed(10),
      entryPrice: livePrice.toFixed(10),
      entryTimestamp: now,
      entryNotionalUsd: notional.toFixed(2),
      status: 'open',
      exitPrice: null,
      exitTimestamp: null,
      exitReason: null,
      realizedPnlUsd: null,
      realizedPnlPct: null,
      stopLossPrice: cmd.stopLossPrice,
      takeProfitPrice: cmd.takeProfitPrice,
      horizonTargetDate: new Date(
        Date.now() + cmd.horizonDays * 86_400_000,
      ).toISOString(),
      estimatedEntryCostUsd: estimatedCost.toFixed(2),
      createdAt: now,
      updatedAt: now,
    };

    // Payload d'insertion — clés snake_case = colonnes lisa_positions. Partagé
    // entre l'INSERT direct (legacy) et la fonction atomique try_open_position
    // (Bug #314 #M3), qui le reçoit en JSONB.
    const insertPayload = {
      id: position.id,
      portfolio_id: position.portfolioId,
      proposal_id: null,
      thesis_id: null,
      symbol: position.symbol,
      asset_class: position.assetClass,
      direction: position.direction,
      venue: position.venue,
      quantity: position.quantity,
      entry_price: position.entryPrice,
      entry_timestamp: position.entryTimestamp,
      entry_notional_usd: position.entryNotionalUsd,
      status: position.status,
      stop_loss_price: position.stopLossPrice,
      take_profit_price: position.takeProfitPrice,
      horizon_target_date: position.horizonTargetDate,
      estimated_entry_cost_usd: position.estimatedEntryCostUsd,
      fees_in_usd: position.estimatedEntryCostUsd,
      venue_fee_detail: { entry: entryFeeBreakdown, source: cmd.source ?? 'direct' },
      created_at: position.createdAt,
      updated_at: position.updatedAt,
    };

    // Bug #314 #M3 — Si maxOpenPositions fourni : ouverture atomique via la
    // fonction DB try_open_position (check cap + insert sous verrou advisory
    // scopé portfolio). Élimine la race scanner/autopilot qui pouvait dépasser
    // le cap. Sinon : INSERT direct, comportement legacy inchangé.
    if (cmd.maxOpenPositions != null) {
      const { data: newId, error: rpcErr } = await this.supabase.rpc('try_open_position', {
        p_portfolio_id: position.portfolioId,
        p_max_open: cmd.maxOpenPositions,
        p_payload: insertPayload,
      });
      if (rpcErr) {
        throw new Error(`openPositionDirect try_open_position RPC failed: ${rpcErr.message}`);
      }
      if (newId == null) {
        // Cap déjà atteint (un autre acteur a pris le dernier slot entre le
        // pré-check du caller et cet appel). Throw reconnaissable : le caller
        // (scanner/autopilot) catch déjà openPositionDirect → log + skip.
        throw new Error(
          `POSITION_CAP_REACHED: portfolio ${position.portfolioId} already at maxOpenPositions=${cmd.maxOpenPositions} (symbol=${cmd.symbol})`,
        );
      }
      return position;
    }

    const { error: insErr } = await this.supabase.from('lisa_positions').insert(insertPayload);
    if (insErr) throw new Error(`openPositionDirect INSERT failed: ${insErr.message}`);

    return position;
  }

  /**
   * Ferme une position avec prix live + raison structurée.
   * Matérialise le P&L réalisé.
   */
  async closePosition(cmd: ClosePositionCommand): Promise<PaperPosition> {
    const { data: posRow, error: fErr } = await this.supabase
      .from('lisa_positions')
      .select('*')
      .eq('id', cmd.positionId)
      .single();
    if (fErr || !posRow) throw new Error(`Position ${cmd.positionId} not found`);

    const position = this.mapRow(posRow);
    if (position.status !== 'open') {
      throw new Error(`Cannot close: position ${cmd.positionId} already ${position.status}`);
    }

    const entryPx = new Decimal(position.entryPrice);
    const exitPx = new Decimal(cmd.livePrice);
    const qty = new Decimal(position.quantity);
    const entryNotional = new Decimal(position.entryNotionalUsd);

    // P&L calculation (long vs short)
    let priceDelta: Decimal;
    if (position.direction === 'long' || position.direction === 'long_call' || position.direction === 'long_put') {
      priceDelta = exitPx.minus(entryPx);
    } else {
      priceDelta = entryPx.minus(exitPx);
    }
    const grossPnl = priceDelta.mul(qty);

    // P19u — Realistic exit fee (IBKR Pro tiered) + closed_invalidated refund.
    //
    // Modèle précédent : 10bps × notional côté exit = ~$2.50 sur trade $2500.
    // ~50× IBKR Pro réel ($0.05 round-trip pour 5 shares × $500). Cf. doc fonction.
    //
    // closed_invalidated = trade tué par news shock / material change avant
    // que le TP/SL hit. Le PaperBroker considère ça comme "no real trade
    // happened" — refund both sides of fees, garde uniquement le price delta.
    // P19x.8 — Capture exit fee breakdown (commission + exchange + regulatory + fx)
    // pour persistence venue_fee_detail.exit + tooltip UI.
    const isLong = position.direction === 'long' || position.direction === 'long_call' || position.direction === 'long_put';
    const exitSide: 'buy' | 'sell' = isLong ? 'sell' : 'buy';
    const exitFeeBreakdown: VenueFeeBreakdown = computeVenueFeeDetail(
      qty,
      exitPx,
      position.assetClass,
      position.venue,
      exitSide,
    );

    let exitCost: Decimal;
    let entryFeeRefund: Decimal;
    if (cmd.reason === 'closed_invalidated') {
      exitCost = new Decimal(0);
      // Refund the entry fee (was already absorbed by the reduced quantity at
      // open time). We add it back to net PnL so the close is fee-neutral.
      const entryCostStored = position.estimatedEntryCostUsd;
      entryFeeRefund = entryCostStored ? new Decimal(entryCostStored) : new Decimal(0);
    } else {
      exitCost = new Decimal(exitFeeBreakdown.total);
      entryFeeRefund = new Decimal(0);
    }
    const netPnl = grossPnl.minus(exitCost).plus(entryFeeRefund);

    // P19x.11 (29/04/2026) — MIN_NET_PROFIT_USD guard avant `closed_target`.
    //
    // Mirror du guard P19x.1 ajouté dans mechanical-trading.service.ts.
    // Le scanner Gainers passe par mechanical-trading donc P19x.1 couvre ces
    // closes. MAIS Lisa LLM proposals + manual closes via paper-broker bypassed
    // ce guard. Constat user (29/04 02:00 UTC) : "TOUTES les positions
    // fermées affichent TP hit + closed_target avec P&L négatif" — preuve que
    // le code path paper-broker a aussi besoin du guard.
    //
    // Garde-fou : un closed_target ne doit JAMAIS résulter en net PnL négatif.
    // Min = max($2, 0.5% × notional). Si net < min → throw RetryableCloseError
    // pour signaler au caller que la close est rejetée. Position reste ouverte.
    if (cmd.reason === 'closed_target') {
      const minNetProfit = Decimal.max(
        new Decimal(2),
        entryNotional.mul(0.005),
      );
      if (netPnl.lt(minNetProfit)) {
        const err = new Error(
          `[PAPER_BROKER] Skip closed_target ${position.symbol}: net=$${netPnl.toFixed(2)} < min=$${minNetProfit.toFixed(2)} ` +
          `(notional=$${entryNotional.toFixed(0)}, gross=$${grossPnl.toFixed(2)}, fees=$${exitCost.toFixed(2)}). Position kept open.`,
        );
        (err as Error & { code?: string }).code = 'CLOSE_TARGET_BELOW_MIN_PROFIT';
        // eslint-disable-next-line no-console
        console.warn(err.message);
        throw err;
      }
    }

    const pnlPct = entryNotional.isZero()
      ? 0
      : netPnl.dividedBy(entryNotional).mul(100).toNumber();

    // R5 sanity inline — issue #409. Le SanityR5Service NestJS (apps/api) protège
    // MechanicalTradingService.closePosition mais PAS ce path (paper-broker dans
    // packages/ai-analyst, cross-package). Avec strategy_mode=gainers, 100 % des
    // closes passent ici → mode non protégé.
    // Bug récurrent : SEE.LSE −$1574 (14/05 exit_price=0), URA/PPLT/CPER −$2200
    // (30/04 force-close-at-zero) = ~$3 000+ historique évitable.
    // Defaults alignés avec SanityR5Service : ratio 0.5, pnl_pct −50, ENABLED=true.
    const r5Enabled = (process.env.R5_SANITY_ENABLED ?? 'true').toLowerCase() === 'true';
    if (r5Enabled) {
      const minRatio = Number(process.env.R5_EXIT_PRICE_MIN_RATIO ?? '0.5');
      const minPnlPct = Number(process.env.R5_PNL_PCT_MIN_THRESHOLD ?? '-50');
      const exitPxN = exitPx.toNumber();
      const entryPxN = entryPx.toNumber();
      let r5Block: { code: string; detail: string } | null = null;
      if (!Number.isFinite(exitPxN) || exitPxN <= 0) {
        r5Block = { code: 'R5_EXIT_PRICE_ZERO', detail: `exit_price=${exitPxN}` };
      } else if (Number.isFinite(entryPxN) && entryPxN > 0 && exitPxN < entryPxN * minRatio) {
        r5Block = {
          code: 'R5_EXIT_BELOW_RATIO',
          detail: `exit=${exitPxN} entry=${entryPxN} ratio=${(exitPxN / entryPxN).toFixed(4)} min=${minRatio}`,
        };
      } else if (Number.isFinite(pnlPct) && pnlPct < minPnlPct) {
        r5Block = {
          code: 'R5_PNL_BELOW_THRESHOLD',
          detail: `pnl_pct=${pnlPct.toFixed(3)} threshold=${minPnlPct}`,
        };
      }
      if (r5Block) {
        const err = new Error(
          `[R5_SANITY_BLOCK_PAPER] ${position.symbol} positionId=${cmd.positionId} ${r5Block.code} ${r5Block.detail} — position kept open, retry next tick`,
        );
        (err as Error & { code?: string }).code = r5Block.code;
        // eslint-disable-next-line no-console
        console.error(err.message);
        throw err;
      }
    }

    const now = new Date().toISOString();

    // 🛡️ Patch B : UPDATE atomique avec WHERE status='open'.
    // Évite le double-close si Lisa (closeRecommendation) et le mécanique
    // (checkStopTarget) tentent de fermer la même position en parallèle.
    // Si une autre transaction a déjà mis status != 'open', cet UPDATE
    // touche 0 rows → on retourne la position fermée précédente sans
    // ré-écrire les champs (pas de double comptage P&L, pas de double
    // appel au TradeOutcomeRecorder).
    // P19x.8 — Merge entry breakdown (déjà persisté à open) + exit breakdown
    // pour conserver le full audit trail dans venue_fee_detail JSONB.
    const existingDetail = (posRow as Record<string, unknown>)['venue_fee_detail'] as
      | { entry?: VenueFeeBreakdown; exit?: VenueFeeBreakdown }
      | null
      | undefined;
    const mergedFeeDetail = {
      entry: existingDetail?.entry ?? null,
      exit: exitFeeBreakdown,
    };

    const { data: updated, error: updErr } = await this.supabase
      .from('lisa_positions')
      .update({
        status: cmd.reason,
        exit_price: exitPx.toFixed(10),
        exit_timestamp: now,
        exit_reason: cmd.rationale,
        realized_pnl_usd: netPnl.toFixed(2),
        realized_pnl_pct: pnlPct,
        // P19x.8 — Persist exit fees breakdown
        fees_out_usd: exitCost.toFixed(4),
        venue_fee_detail: mergedFeeDetail,
        updated_at: now,
      })
      .eq('id', cmd.positionId)
      .eq('status', 'open')
      .select('*');
    if (updErr) throw new Error(`Paper position close failed: ${updErr.message}`);

    // 0 rows updated = la position avait déjà été fermée par un autre acteur
    // entre notre SELECT (line 168) et l'UPDATE. Retour silencieux pour ne
    // pas casser le caller, mais on log un warning.
    if (!updated || updated.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[PAPER_BROKER] closePosition ${cmd.positionId} race detected — already closed by another actor, skipping double-close`);
      return position; // état d'avant, déjà cohérent avec la DB
    }

    // Miroir paper_trades — UPDATE en aval pour débloquer P9 ML refit.
    // paper_trades est une table audit séparée alimentée par le scanner
    // au INSERT seulement (top-gainers-scanner.service.ts:3674). Sans cette
    // mise à jour miroir, paper_trades reste à status='open' pour toujours
    // → P9 logistic regression `insufficient_sample` perpétuel.
    //
    // Best-effort : wrap try/catch isolé. Si l'UPDATE échoue (race, row
    // absente pour les positions Lisa LLM non-scanner, etc.) → log warn,
    // close lisa_positions reste effective. Zéro impact sur le trading réel.
    try {
      const entryTs = new Date(position.entryTimestamp).getTime();
      const closedTs = new Date(now).getTime();
      const holdSec = Math.max(0, Math.floor((closedTs - entryTs) / 1000));
      // outcome_label SMALLINT : 1 = win (pnl > 0), 0 = loss/flat (pnl ≤ 0).
      // Aligné avec persistence-probability.service.ts:348.
      const outcomeLabel = pnlPct > 0 ? 1 : 0;
      // paper_trades.status est sous CHECK ('open', 'closed', 'cancelled').
      // lisa_positions.status a une granularité plus fine ('closed_target',
      // 'closed_stop', etc) → on simplifie à 'closed' ici. Le détail précis
      // reste dans lisa_positions, lié via scanner_position_id.
      const { error: mirErr } = await this.supabase
        .from('paper_trades')
        .update({
          status: 'closed',
          closed_at: now,
          exit_price: exitPx.toFixed(10),
          pnl_usd: netPnl.toFixed(2),
          pnl_pct: pnlPct,
          hold_duration_seconds: holdSec,
          outcome_label: outcomeLabel,
          updated_at: now,
        })
        .eq('scanner_position_id', cmd.positionId)
        .eq('status', 'open');
      if (mirErr) {
        // eslint-disable-next-line no-console
        console.warn(`[PAPER_BROKER] paper_trades mirror update failed for ${cmd.positionId}: ${mirErr.message}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[PAPER_BROKER] paper_trades mirror exception for ${cmd.positionId}: ${String(e).slice(0, 200)}`);
    }

    return {
      ...position,
      status: cmd.reason,
      exitPrice: exitPx.toFixed(10),
      exitTimestamp: now,
      exitReason: cmd.rationale,
      realizedPnlUsd: netPnl.toFixed(2),
      realizedPnlPct: pnlPct,
      updatedAt: now,
    };
  }

  /**
   * Récupère toutes les positions (open + closed) d'un portefeuille.
   */
  async getPositions(portfolioId: string, openOnly = false): Promise<PaperPosition[]> {
    let q = this.supabase
      .from('lisa_positions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('entry_timestamp', { ascending: false });
    if (openOnly) q = q.eq('status', 'open');

    const { data, error } = await q;
    if (error) throw new Error(`Fetch positions failed: ${error.message}`);
    return (data ?? []).map(this.mapRow);
  }

  /**
   * Computes un snapshot P&L instantané du portefeuille.
   * Utilisé pour les charts et le risk monitor.
   */
  async computeSnapshot(portfolioId: string): Promise<PortfolioSnapshot> {
    const openPositions = await this.getPositions(portfolioId, true);
    const allPositions = await this.getPositions(portfolioId, false);

    // Fetch live prices pour toutes les open positions
    const priceMap = new Map<string, Decimal>();
    for (const pos of openPositions) {
      if (!priceMap.has(pos.symbol)) {
        try {
          const quote = await this.fetchLivePrice(pos.symbol);
          // 🛡️ GARDE-FOU CRITIQUE — bug 27/04 02:01 :
          // Si fetchLivePrice retourne un fallback hardcoded (LMT=100, GLD=310,
          // SLV=31...), le snapshot calcule une valeur portefeuille massivement
          // erronée → drawdown_from_peak_pct faux → P4.1 Kill-switch armé sur
          // fausse alerte (incident 27/04 nocturne).
          // Solution : si source fallback, utiliser entry_price (PnL latent
          // honnête à 0% pour cette position en attendant que EODHD revienne).
          if (quote.source && quote.source.startsWith('fallback')) {
            priceMap.set(pos.symbol, new Decimal(pos.entryPrice));
          } else {
            priceMap.set(pos.symbol, new Decimal(quote.price));
          }
        } catch {
          // Fallback sur entry price si quote unavailable
          priceMap.set(pos.symbol, new Decimal(pos.entryPrice));
        }
      }
    }

    // Unrealized P&L
    let unrealized = new Decimal(0);
    let openValue = new Decimal(0);
    for (const pos of openPositions) {
      const livePx = priceMap.get(pos.symbol) ?? new Decimal(pos.entryPrice);
      const qty = new Decimal(pos.quantity);
      const entryPx = new Decimal(pos.entryPrice);

      const priceDelta =
        pos.direction === 'long' || pos.direction === 'long_call' || pos.direction === 'long_put'
          ? livePx.minus(entryPx)
          : entryPx.minus(livePx);

      const posPnl = priceDelta.mul(qty);
      unrealized = unrealized.plus(posPnl);

      // Current market value
      openValue = openValue.plus(livePx.mul(qty));
    }

    // Realized P&L cumulative
    const realized = allPositions
      .filter((p) => p.status !== 'open' && p.realizedPnlUsd !== null)
      .reduce((s, p) => s.plus(new Decimal(p.realizedPnlUsd ?? '0')), new Decimal(0));

    // Fetch portfolio base capital
    const { data: portfolio } = await this.supabase
      .from('portfolios')
      .select('simulation_initial_capital, base_currency')
      .eq('id', portfolioId)
      .single();

    const initialCapital = new Decimal((portfolio?.simulation_initial_capital as string | null) ?? '10000');

    // Cash = initial + realized - entry cost of open positions + (value - initial capital = appreciation in open)
    const openEntryNotionalSum = openPositions.reduce(
      (s, p) => s.plus(new Decimal(p.entryNotionalUsd)),
      new Decimal(0),
    );
    const cash = initialCapital.plus(realized).minus(openEntryNotionalSum);
    const totalValue = cash.plus(openValue);

    const returnFromInception = initialCapital.isZero()
      ? 0
      : totalValue.minus(initialCapital).dividedBy(initialCapital).mul(100).toNumber();

    // Drawdown from peak (requires history — compute later from snapshots)
    const drawdownFromPeak = await this.computeDrawdownFromPeak(portfolioId, totalValue);

    const now = new Date().toISOString();
    const snapshot: PortfolioSnapshot = {
      id: randomUUID(),
      portfolioId,
      timestamp: now,
      cashUsd: cash.toFixed(2),
      openPositionsValueUsd: openValue.toFixed(2),
      totalValueUsd: totalValue.toFixed(2),
      realizedPnlCumulativeUsd: realized.toFixed(2),
      unrealizedPnlUsd: unrealized.toFixed(2),
      returnFromInceptionPct: returnFromInception,
      openPositionsCount: openPositions.length,
      drawdownFromPeakPct: drawdownFromPeak,
      marketContextSummary: null,
    };

    // Persist snapshot (for charts)
    const { error: insErr } = await this.supabase.from('lisa_portfolio_snapshots').insert({
      id: snapshot.id,
      portfolio_id: snapshot.portfolioId,
      timestamp: snapshot.timestamp,
      cash_usd: snapshot.cashUsd,
      open_positions_value_usd: snapshot.openPositionsValueUsd,
      total_value_usd: snapshot.totalValueUsd,
      realized_pnl_cumulative_usd: snapshot.realizedPnlCumulativeUsd,
      unrealized_pnl_usd: snapshot.unrealizedPnlUsd,
      return_from_inception_pct: snapshot.returnFromInceptionPct,
      open_positions_count: snapshot.openPositionsCount,
      drawdown_from_peak_pct: snapshot.drawdownFromPeakPct,
    });
    if (insErr) {
      // Non-fatal — log but continue
      console.warn(`Snapshot persist failed: ${insErr.message}`);
    }

    return snapshot;
  }

  /**
   * Compute drawdown depuis le peak observé (all-time high) du portefeuille.
   */
  private async computeDrawdownFromPeak(portfolioId: string, currentValue: Decimal): Promise<number> {
    const { data } = await this.supabase
      .from('lisa_portfolio_snapshots')
      .select('total_value_usd')
      .eq('portfolio_id', portfolioId)
      .order('total_value_usd', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return 0;
    const peak = new Decimal(data.total_value_usd as string);
    if (peak.isZero()) return 0;
    const dd = currentValue.minus(peak).dividedBy(peak).mul(100).toNumber();
    return Math.min(dd, 0);  // drawdown is negative or zero
  }

  private mapRow(row: Record<string, unknown>): PaperPosition {
    return {
      id: row.id as string,
      portfolioId: row.portfolio_id as string,
      proposalId: (row.proposal_id as string | null) ?? null,
      thesisId: (row.thesis_id as string | null) ?? null,
      symbol: row.symbol as string,
      assetClass: row.asset_class as string,
      direction: row.direction as PaperPosition['direction'],
      venue: row.venue as string,
      quantity: row.quantity as string,
      entryPrice: row.entry_price as string,
      entryTimestamp: row.entry_timestamp as string,
      entryNotionalUsd: row.entry_notional_usd as string,
      status: row.status as PaperPosition['status'],
      exitPrice: (row.exit_price as string | null) ?? null,
      exitTimestamp: (row.exit_timestamp as string | null) ?? null,
      exitReason: (row.exit_reason as string | null) ?? null,
      realizedPnlUsd: (row.realized_pnl_usd as string | null) ?? null,
      realizedPnlPct: (row.realized_pnl_pct as number | null) ?? null,
      stopLossPrice: (row.stop_loss_price as string | null) ?? null,
      takeProfitPrice: (row.take_profit_price as string | null) ?? null,
      horizonTargetDate: (row.horizon_target_date as string | null) ?? null,
      estimatedEntryCostUsd: row.estimated_entry_cost_usd as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
