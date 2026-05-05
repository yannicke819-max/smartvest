/**
 * Hotfix EODHD bypass — utilitaire partagé pour appliquer le suffix exchange
 * EODHD à un ticker raw avant fetch intraday.
 *
 * Contexte (rapport user 05/05/2026 12:20 UTC) :
 * Les logs Fly montraient des HTTP 404 récurrents sur des tickers raw
 * (NOCIL, BHEL, 005940, 600322…) parce que :
 *   - PR #234 a corrigé `mapEodhdRow` côté scanner (suffix correctement
 *     appliqué AVANT INSERT shadow signals)
 *   - MAIS ShadowExitSimulator + SignalForwardTracker lisaient des rows
 *     LEGACY (pré-PR #234) où le symbol était stocké raw → 404 sur fetch
 *
 * Cette utilitaire centralise la logique de mapping suffix pour usage
 * défensif côté consumers de `gainers_v1_shadow_signals` /
 * `gainers_signal_forward`.
 *
 * Mapping aligné avec :
 *   - vendor/eodhd-claude-skills/skills/eodhd-api/references/general/symbol-format.md
 *   - top-gainers-scanner.service.ts:ensureExchangeSuffix
 *   - eodhd-intraday.service.ts:normalizeForEodhdIntraday
 */

/**
 * Si `symbol` contient déjà un point (ex: "005940.KO"), retourne tel quel.
 * Sinon, applique le suffix correspondant à `exchange` (uppercase normalisé).
 *
 * Cas spécial : Tokyo (`T`) → suffix `.T` (PAS `.TSE` ; le scanner historique
 * écrivait `.TSE` mais EODHD intraday API attend `.T`. Cf.
 * normalizeForEodhdIntraday qui gère le legacy `.TSE` → `.T`).
 *
 * Si `exchange` est null ou vide, fallback `.US` + WARN console.
 */
export function ensureEodhdSuffix(symbol: string, exchange: string | null | undefined): string {
  if (!symbol) return symbol;
  if (symbol.includes('.')) return symbol;
  const ex = (exchange ?? '').toString().toUpperCase().trim();
  if (!ex) {
    // Fallback raisonnable : on suppose US. Si erreur, le caller verra le 404
    // et le log normalizeForEodhdIntraday aidera au diagnostic.
    return `${symbol}.US`;
  }
  // EODHD attend `.T` pour Tokyo, pas `.TSE`. Le scanner peut avoir écrit
  // `T` ou `TSE` selon la version → on normalise vers `T`.
  if (ex === 'T' || ex === 'TSE') return `${symbol}.T`;
  // Pour tous les autres exchanges, suffix = code uppercase tel quel.
  // Couvre : US, LSE, XETRA, PA, SW, MI, MC, BME, AS, AMS, HK, AU, KO, KQ,
  // TO, NSE, BSE, SHG, SHE.
  return `${symbol}.${ex}`;
}
