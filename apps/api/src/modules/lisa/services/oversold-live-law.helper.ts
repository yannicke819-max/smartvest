/**
 * Phase 2 — Fermeture de la boucle d'apprentissage oversold.
 *
 * Le gain-picker décide « rebond corrigé → CLOSE » quand `pnl ≥ expected_alpha`.
 * Jusqu'ici `expected_alpha` venait de constantes BACKTEST hardcodées (bandAlpha).
 * Ici on calcule l'alpha LIVE (rendement forward-J10 moyen par bande de drop,
 * appris sur paper_trades), et on l'utilise dès qu'une bande a assez d'échantillon
 * — sinon fallback backtest. Tant qu'aucun label J+10 n'existe (avant ~18/06), le
 * sample est 0 partout → fallback systématique → comportement identique à avant.
 * Quand les labels arrivent, l'expected_alpha s'auto-calibre par portefeuille.
 *
 * Pure functions → testables sans DB.
 */

export type GainPickerBand = '>-3%' | '-3/-5%' | '-5/-8%' | '-8/-12%' | '<-12%';

/** Bandes COARSE du gain-picker — DOIVENT matcher l'ancien bandAlpha (cohérence prompt). */
export function gainPickerBand(dropPct: number): GainPickerBand {
  if (dropPct > -3) return '>-3%';
  if (dropPct > -5) return '-3/-5%';
  if (dropPct > -8) return '-5/-8%';
  if (dropPct >= -12) return '-8/-12%';
  return '<-12%';
}

/** Alpha BACKTEST fondateur (fallback) : band → rebond cible attendu (%). */
export const BACKTEST_BAND_ALPHA: Record<GainPickerBand, number | null> = {
  '>-3%': null,
  '-3/-5%': 0,
  '-5/-8%': 1.0,
  '-8/-12%': 2.45,
  '<-12%': -1.97,
};

export interface BandLawEntry {
  alpha: number; // rendement forward-J10 moyen (%)
  n: number; // nombre de trades labellisés dans la bande
}

/** Agrège les rendements forward-J10 par bande de drop → alpha live + sample. */
export function computeLiveBandLaw(
  samples: Array<{ drop: number; fwdReturnPct: number }>,
): Partial<Record<GainPickerBand, BandLawEntry>> {
  const groups: Partial<Record<GainPickerBand, number[]>> = {};
  for (const s of samples) {
    if (!Number.isFinite(s.drop) || !Number.isFinite(s.fwdReturnPct)) continue;
    const b = gainPickerBand(s.drop);
    (groups[b] ??= []).push(s.fwdReturnPct);
  }
  const out: Partial<Record<GainPickerBand, BandLawEntry>> = {};
  for (const b of Object.keys(groups) as GainPickerBand[]) {
    const vals = groups[b]!;
    out[b] = { alpha: vals.reduce((a, v) => a + v, 0) / vals.length, n: vals.length };
  }
  return out;
}

export interface ResolvedBandAlpha {
  band: GainPickerBand;
  alpha: number | null;
  source: 'live' | 'backtest';
  n: number; // échantillon live disponible pour la bande (0 si aucun)
}

/**
 * Résout l'alpha attendu pour un drop d'entrée : la loi LIVE si la bande a
 * ≥ minSample trades labellisés, sinon la constante backtest.
 */
export function resolveBandAlpha(
  dropPct: number,
  live: Partial<Record<GainPickerBand, BandLawEntry>>,
  minSample: number,
): ResolvedBandAlpha {
  const band = gainPickerBand(dropPct);
  const liveEntry = live[band];
  if (liveEntry && liveEntry.n >= minSample) {
    return { band, alpha: Math.round(liveEntry.alpha * 100) / 100, source: 'live', n: liveEntry.n };
  }
  return { band, alpha: BACKTEST_BAND_ALPHA[band], source: 'backtest', n: liveEntry?.n ?? 0 };
}
