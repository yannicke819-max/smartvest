/**
 * PR #367 — Gate de liquidité minimum (anti-slippage).
 *
 * Diagnostic 20/05/2026 : sur 48h, le stop nominal -1.5% se réalisait en
 * moyenne à -2.69% (jusqu'à -7.69%) sur les small-caps illiquides asia
 * (.KQ KOSDAQ, .SHG/.SHE Chine) + penny LSE. Pas de liquidité au prix du
 * stop → exécution gap-down 2-5× plus bas. R:R réel dégradé à 1.2:1 →
 * saignée mécanique malgré WR 30%.
 *
 * Le champ market_cap est en DEVISE LOCALE (KRW/CNY/EUR/GBP), pas USD —
 * inutilisable comme gate USD. On gate donc sur le DOLLAR-VOLUME quotidien :
 *   dollar_volume_usd = avgVol50d (shares) × close (devise locale) × fx_to_usd
 *
 * FX statique (ordre de grandeur suffit pour un plancher de liquidité ;
 * une erreur ±10% ne change pas le verdict $2M). À recalibrer si une devise
 * dérive durablement. GBp (pence LSE) intégré dans le multiplicateur.
 */

// Multiplicateur devise locale → USD, clé = suffixe EODHD (sans point).
// Pas de suffixe = US (USD = 1).
const FX_TO_USD: Record<string, number> = {
  US: 1,
  TO: 0.73, // CAD
  // Europe
  L: 0.0127, // LSE en pence (GBp) : GBP/USD ÷ 100
  LSE: 0.0127,
  PA: 1.08, // EUR
  AS: 1.08,
  AMS: 1.08,
  BR: 1.08,
  LS: 1.08,
  MI: 1.08,
  XETRA: 1.08,
  DE: 1.08,
  MC: 1.08,
  BME: 1.08,
  SW: 1.10, // CHF
  // Asia
  KO: 0.00073, // KRW
  KQ: 0.00073,
  KS: 0.00073,
  KE: 0.00073,
  SHG: 0.139, // CNY
  SHE: 0.139,
  T: 0.00645, // JPY
  HK: 0.128, // HKD
  AU: 0.66, // AUD
  NSE: 0.012, // INR
  BSE: 0.012,
};

export function fxToUsd(symbol: string): number {
  if (!symbol.includes('.')) return 1; // US sans suffixe
  const suffix = symbol.split('.')[1];
  return FX_TO_USD[suffix] ?? 1; // devise inconnue → no-op (multiplicateur 1)
}

export interface LiquidityGateResult {
  pass: boolean;
  dollarVolumeUsd: number | null;
  reason?: string;
}

/**
 * Évalue le gate liquidité.
 *
 * - `avgVol50d <= 0` ou `close <= 0` → fail-open (pass=true, données manquantes,
 *   on ne bloque pas sur une absence de donnée).
 * - `minUsd <= 0` → gate désactivé (pass=true).
 * - Sinon : pass si dollar_volume_usd >= minUsd.
 */
export function evaluateLiquidityGate(
  symbol: string,
  close: number,
  avgVol50d: number,
  minUsd: number,
): LiquidityGateResult {
  if (minUsd <= 0) return { pass: true, dollarVolumeUsd: null };
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(avgVol50d) || avgVol50d <= 0) {
    return { pass: true, dollarVolumeUsd: null, reason: 'no_volume_data_fail_open' };
  }
  const dollarVolumeUsd = avgVol50d * close * fxToUsd(symbol);
  if (dollarVolumeUsd < minUsd) {
    return {
      pass: false,
      dollarVolumeUsd,
      reason: `dollar_volume $${(dollarVolumeUsd / 1e6).toFixed(2)}M < min $${(minUsd / 1e6).toFixed(2)}M`,
    };
  }
  return { pass: true, dollarVolumeUsd };
}
