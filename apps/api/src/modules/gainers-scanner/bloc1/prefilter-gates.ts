/**
 * BLOC 1 — Prefilter gates purs (ADR-005 §1bis).
 *
 * Les 4 seuils V1 officiels :
 *   1. Liquidity floor : equity median daily $vol 20j ≥ $10M ; crypto 24h $vol ≥ $50M
 *   2. Market cap min  : equity ≥ $300M ; crypto circ_supply×price ≥ $500M
 *   3. Volatility clamp: ATR(14, daily)/close ≤ 0.15 (15%)
 *   4. Persistence gate: persistenceScore ≥ gainers_min_persistence_score
 *
 * Toutes les fonctions sont pures et idempotentes — pas d'I/O, pas d'état.
 */

import { CandidateRejectReason } from '../domain/gainers-enums';
import type { GainersCandidateRaw } from '../domain/gainers-candidate.types';

export interface GainersBloc1Config {
  /** Seuil liquidité equity : median daily $vol 20j (USD). Défaut $10M. */
  liquidityFloorEquityUsd: number;
  /** Seuil liquidité crypto : 24h $vol (USD). Défaut $50M. */
  liquidityFloorCryptoUsd: number;
  /** Seuil market cap minimum equity (USD). Défaut $300M. */
  marketCapMinEquityUsd: number;
  /** Seuil market cap minimum crypto = circ_supply × price (USD). Défaut $500M. */
  marketCapMinCryptoUsd: number;
  /** Volatility clamp : ATR(14, daily) / close max. Défaut 0.15. */
  volatilityClampMaxAtrRel: number;
  /** Score persistance minimum P8 ([0..1]). Défaut 0.67. */
  minPersistenceScore: number;
  /**
   * PR6.4 — opt-in shadow mode dégradé : si true et atrDailyRelative null
   * → SKIP (PASS) au lieu de FAIL. Idem pour persistenceScore null.
   * Default false : préserve comportement strict prod (algos lockés ADR-005 §1bis).
   */
  shadowSkipNullFields?: boolean;
}

export const DEFAULT_BLOC1_CONFIG: GainersBloc1Config = {
  liquidityFloorEquityUsd: 10_000_000,
  liquidityFloorCryptoUsd: 50_000_000,
  marketCapMinEquityUsd: 300_000_000,
  marketCapMinCryptoUsd: 500_000_000,
  volatilityClampMaxAtrRel: 0.15,
  minPersistenceScore: 0.67,
  shadowSkipNullFields: false,
};

/** Shadow run : version dégradée tolérante aux nulls (atr/persistence). */
export const SHADOW_BLOC1_CONFIG: GainersBloc1Config = {
  ...DEFAULT_BLOC1_CONFIG,
  shadowSkipNullFields: true,
};

/**
 * PR6.6.4 (TEMPORAIRE) — Bypass LIQUIDITY_FLOOR pour les 5 crypto majors hardcoded.
 *
 * Contexte : weekend Sat-Sun, volumes Binance crypto chutent ×3-10 vs weekday
 * (BNB $36M sat vs $400M weekday typique). 7/10 majors fail liquidity à tort
 * en regime low-vol. Bilan A3 lundi 13:00 UTC bloqué à 0 ACCEPT → 14j paralysie
 * en attendant RCFT productive (mardi 17/05+).
 *
 * Solution intermédiaire : skip LIQUIDITY_FLOOR pour BTC/ETH/BNB/SOL/XRP
 * (top 5 par market cap, tous > $50B). Persistence gate aval reste actif
 * (filtre légitime, pas bypass).
 *
 * TODO REMOVAL DATE : 2026-05-17 (mardi, T+14j RCFT data productive).
 * Une fois RCFT fournit FP-rate par gate, AutoTuner V2 #224 propose
 * relaxation seuil officielle ADR-005 §1bis si justifiée par data.
 *
 * Sécurité : whitelist explicite des 5 symbols les plus liquides au monde,
 * impossible que market cap < $50B → liquidity réelle largement OK toutes
 * sessions. Risque pump-and-dump nul sur ces majors.
 */
export const TOP5_CRYPTO_BYPASS_LIQUIDITY = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];

export interface GateResult {
  pass: boolean;
  reason: CandidateRejectReason | null;
  observed: number | null;
  threshold: number | null;
}

const FAIL = (reason: CandidateRejectReason, observed: number | null, threshold: number): GateResult => ({
  pass: false,
  reason,
  observed,
  threshold,
});

const PASS = (observed: number | null, threshold: number): GateResult => ({
  pass: true,
  reason: null,
  observed,
  threshold,
});

/** Gate 1 — Liquidity floor (equity/crypto-aware). */
export function checkLiquidityFloor(raw: GainersCandidateRaw, cfg: GainersBloc1Config): GateResult {
  if (raw.market === 'crypto') {
    const threshold = cfg.liquidityFloorCryptoUsd;
    // PR6.6.4 — bypass top 5 crypto majors (TEMPORAIRE jusqu'à 2026-05-17 RCFT productive)
    if (TOP5_CRYPTO_BYPASS_LIQUIDITY.includes(raw.symbol)) {
      return PASS(raw.vol24hUsd, threshold);
    }
    if (raw.vol24hUsd < threshold) return FAIL(CandidateRejectReason.LIQUIDITY_FLOOR, raw.vol24hUsd, threshold);
    return PASS(raw.vol24hUsd, threshold);
  }
  const threshold = cfg.liquidityFloorEquityUsd;
  const vol = raw.medianDailyVolUsd20d;
  // P19-EU-FIX (25/05/2026) : EODHD ne remonte pas medianDailyVolUsd20d pour
  // beaucoup de tickers EU (.PA/.XETRA/.MI/.AS). Fallback sur vol24hUsd quand
  // disponible — un titre EU mid/large cap qui trade > $10M sur la journée
  // est largement assez liquide. Sans ce fallback, ~80% des candidats EU
  // fail LIQUIDITY_FLOOR sur null → 0 ouverture EU. Crypto path inchangé.
  if (vol === null) {
    if (raw.vol24hUsd >= threshold) {
      return PASS(raw.vol24hUsd, threshold);
    }
    return FAIL(CandidateRejectReason.LIQUIDITY_FLOOR, raw.vol24hUsd, threshold);
  }
  if (vol < threshold) return FAIL(CandidateRejectReason.LIQUIDITY_FLOOR, vol, threshold);
  return PASS(vol, threshold);
}

/** Gate 2 — Market cap minimum. */
export function checkMarketCapMin(raw: GainersCandidateRaw, cfg: GainersBloc1Config): GateResult {
  const threshold = raw.market === 'crypto' ? cfg.marketCapMinCryptoUsd : cfg.marketCapMinEquityUsd;
  const mcap = raw.marketCapUsd;
  if (mcap === null) return FAIL(CandidateRejectReason.MARKET_CAP_MIN, null, threshold);
  if (mcap < threshold) return FAIL(CandidateRejectReason.MARKET_CAP_MIN, mcap, threshold);
  return PASS(mcap, threshold);
}

/** Gate 3 — Volatility clamp ATR(14, daily) / close ≤ 0.15. */
export function checkVolatilityClamp(raw: GainersCandidateRaw, cfg: GainersBloc1Config): GateResult {
  const threshold = cfg.volatilityClampMaxAtrRel;
  const atrRel = raw.atrDailyRelative;
  if (atrRel === null) {
    // PR6.4 shadow mode : tolère null pour scanner dégradé sans cache OHLC daily
    if (cfg.shadowSkipNullFields) return PASS(null, threshold);
    return FAIL(CandidateRejectReason.VOLATILITY_CLAMP, null, threshold);
  }
  if (atrRel > threshold) return FAIL(CandidateRejectReason.VOLATILITY_CLAMP, atrRel, threshold);
  return PASS(atrRel, threshold);
}

/** Gate 4 — Persistence ≥ gainers_min_persistence_score. */
export function checkPersistence(raw: GainersCandidateRaw, cfg: GainersBloc1Config): GateResult {
  const threshold = cfg.minPersistenceScore;
  const score = raw.persistenceScore;
  if (score === null) {
    // PR6.4 shadow mode : tolère null si persistence service indispo (Yahoo fallback échoue)
    if (cfg.shadowSkipNullFields) return PASS(null, threshold);
    return FAIL(CandidateRejectReason.PERSISTENCE_BELOW_THRESHOLD, null, threshold);
  }
  if (score < threshold) return FAIL(CandidateRejectReason.PERSISTENCE_BELOW_THRESHOLD, score, threshold);
  return PASS(score, threshold);
}

/**
 * Évalue toutes les gates dans l'ordre et retourne le premier échec.
 * Ordre choisi pour minimiser le coût : liquidity (cheap) → mcap → vol → persistence.
 */
export function runAllPrefilterGates(
  raw: GainersCandidateRaw,
  cfg: GainersBloc1Config,
): { pass: boolean; firstFailedReason: CandidateRejectReason | null; gates: Record<string, GateResult> } {
  const gates: Record<string, GateResult> = {
    liquidity: checkLiquidityFloor(raw, cfg),
    marketCap: checkMarketCapMin(raw, cfg),
    volatility: checkVolatilityClamp(raw, cfg),
    persistence: checkPersistence(raw, cfg),
  };
  const firstFailed = Object.values(gates).find((g) => !g.pass);
  return {
    pass: !firstFailed,
    firstFailedReason: firstFailed?.reason ?? null,
    gates,
  };
}
