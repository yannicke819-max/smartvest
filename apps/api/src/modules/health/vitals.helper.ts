/**
 * vitals.helper.ts — logique pure du dead man's switch (testable sans DB).
 *
 * Incident 24/07/2026 : scans oversold gelés 4h (await pendu) pendant que
 * /health répondait 200 → Fly voyait une machine « verte » à moitié morte.
 * /health/vitals prouve EN BASE que les boucles vitales battent encore, et
 * renvoie 503 sinon → branché en [[http_service.checks]] Fly, un gel devient
 * un restart automatique de ~60s au lieu d'heures silencieuses.
 */

/**
 * Fenêtre où des scans oversold sont ATTENDUS : lun-ven 08:00-20:00 UTC
 * (cron intraday `0 *\/5 8-20 * * 1-5`). Hors fenêtre (nuit, weekend), le
 * silence est normal → pas de verdict stale possible.
 */
export function isOversoldScanWindow(now: Date): boolean {
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = now.getUTCHours();
  return h >= 8 && h < 20;
}

export interface VitalCheck {
  name: string;
  ok: boolean;
  skipped: string | null; // raison du skip (hors fenêtre, feature off, db err…)
  age_sec: number | null;
  budget_sec: number;
}

/** Verdict d'un vital : stale si l'âge dépasse le budget (âge inconnu = stale). */
export function vitalVerdict(name: string, lastTs: string | null, budgetSec: number, now = new Date()): VitalCheck {
  if (!lastTs) return { name, ok: false, skipped: null, age_sec: null, budget_sec: budgetSec };
  const ageSec = Math.floor((now.getTime() - new Date(lastTs).getTime()) / 1000);
  return { name, ok: ageSec <= budgetSec, skipped: null, age_sec: ageSec, budget_sec: budgetSec };
}

export function skippedVital(name: string, reason: string, budgetSec: number): VitalCheck {
  return { name, ok: true, skipped: reason, age_sec: null, budget_sec: budgetSec };
}
