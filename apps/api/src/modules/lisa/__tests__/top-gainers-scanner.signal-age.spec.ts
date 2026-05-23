/**
 * Phase E-A — Signal age cut (anti-late-entry).
 *
 * Constat : le scanner cycle peut prendre 10-30s pour processer tous les
 * candidats (fetch multi-TF, sim, etc.). Pour un signal momentum 1-min,
 * entrer 30s après détection = entrer après que le pop ait potentiellement
 * retracé. Ce filtre coupe les signaux trop vieux.
 *
 * Helper pur extrait pour testabilité — la logique réelle est inline dans
 * top-gainers-scanner.service.ts (~ligne 2255).
 */

function shouldRejectByAge(cycleStartMs: number, nowMs: number, maxAgeSec: number): boolean {
  if (maxAgeSec <= 0) return false;
  const ageSec = (nowMs - cycleStartMs) / 1000;
  return ageSec > maxAgeSec;
}

describe('Phase E-A — reject_signal_stale (signal age cut)', () => {
  const cycleStart = 1000_000;

  describe('back-compat', () => {
    it('maxAgeSec=0 → toujours OK (default)', () => {
      expect(shouldRejectByAge(cycleStart, cycleStart + 60_000, 0)).toBe(false);
      expect(shouldRejectByAge(cycleStart, cycleStart + 999_999, 0)).toBe(false);
    });

    it('maxAgeSec négatif → désactivé', () => {
      expect(shouldRejectByAge(cycleStart, cycleStart + 30_000, -1)).toBe(false);
    });
  });

  describe('activation', () => {
    it('âge < seuil → OK', () => {
      // Seuil 30s, âge 15s
      expect(shouldRejectByAge(cycleStart, cycleStart + 15_000, 30)).toBe(false);
      // Seuil 30s, âge 29.9s
      expect(shouldRejectByAge(cycleStart, cycleStart + 29_900, 30)).toBe(false);
    });

    it('âge > seuil → reject', () => {
      // Seuil 30s, âge 31s
      expect(shouldRejectByAge(cycleStart, cycleStart + 31_000, 30)).toBe(true);
      // Seuil 60s, âge 90s
      expect(shouldRejectByAge(cycleStart, cycleStart + 90_000, 60)).toBe(true);
    });

    it('âge = seuil → OK (égalité non rejetée)', () => {
      expect(shouldRejectByAge(cycleStart, cycleStart + 30_000, 30)).toBe(false);
    });
  });

  describe('cas réalistes', () => {
    it('cycle latency ~5s (cas normal) → OK même seuil agressif', () => {
      expect(shouldRejectByAge(cycleStart, cycleStart + 5_000, 30)).toBe(false);
      expect(shouldRejectByAge(cycleStart, cycleStart + 5_000, 10)).toBe(false);
    });

    it('cycle stuck >60s (cas pathologique) → reject', () => {
      // Cycle bloqué 90s par un fetch lent
      expect(shouldRejectByAge(cycleStart, cycleStart + 90_000, 60)).toBe(true);
      expect(shouldRejectByAge(cycleStart, cycleStart + 90_000, 30)).toBe(true);
    });

    it('seuil 30s + cycle de 12s → OK (latency normale)', () => {
      // Mesure prod typique : 12s de loop time, on garde tous les signaux
      expect(shouldRejectByAge(cycleStart, cycleStart + 12_000, 30)).toBe(false);
    });

    it('seuil 30s + cycle de 35s → reject (anomalie)', () => {
      // Si la loop prend 35s (anomalie), on coupe les derniers candidats
      expect(shouldRejectByAge(cycleStart, cycleStart + 35_000, 30)).toBe(true);
    });
  });
});
