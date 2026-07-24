import { isOversoldScanWindow, vitalVerdict, skippedVital } from '../vitals.helper';

describe('vitals.helper — dead man\'s switch (logique pure)', () => {
  it('fenêtre scans : lun-ven 08-20 UTC uniquement', () => {
    expect(isOversoldScanWindow(new Date('2026-07-24T14:30:00Z'))).toBe(true);  // vendredi 14:30
    expect(isOversoldScanWindow(new Date('2026-07-24T07:59:00Z'))).toBe(false); // avant fenêtre
    expect(isOversoldScanWindow(new Date('2026-07-24T20:01:00Z'))).toBe(false); // après fenêtre
    expect(isOversoldScanWindow(new Date('2026-07-25T12:00:00Z'))).toBe(false); // samedi
    expect(isOversoldScanWindow(new Date('2026-07-26T12:00:00Z'))).toBe(false); // dimanche
  });

  it('verdict : ok sous le budget, stale au-dessus (le gel de 4h du 24/07 aurait déclenché)', () => {
    const now = new Date('2026-07-24T14:30:00Z');
    const fresh = vitalVerdict('scans', '2026-07-24T14:15:00Z', 35 * 60, now); // 15 min
    expect(fresh.ok).toBe(true);
    const gel = vitalVerdict('scans', '2026-07-24T10:45:00Z', 35 * 60, now); // 3h45 = l'incident réel
    expect(gel.ok).toBe(false);
    expect(gel.age_sec).toBe(13500);
  });

  it('aucun timestamp = stale (jamais battu = anormal en fenêtre)', () => {
    expect(vitalVerdict('scans', null, 2100).ok).toBe(false);
  });

  it('skippedVital = toujours ok avec raison (hors fenêtre / feature off / blip db)', () => {
    const s = skippedVital('news', 'EODHD_NEWS_PERSIST_ENABLED=false', 2700);
    expect(s.ok).toBe(true);
    expect(s.skipped).toContain('false');
  });
});
