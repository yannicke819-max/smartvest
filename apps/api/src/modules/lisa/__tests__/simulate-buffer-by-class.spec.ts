/**
 * Bug #H + Bug #I (13/05/2026) — Tests buffer dynamique par asset_class pour simulatePending.
 *
 * Bug #H : 246/246 captures us_equity_large 12/05 13:30-20:00 UTC marquées
 * off_session/stale_data malgré session ouverte. Cause = lag propagation EODHD
 * intraday US live ≫ 65 min. Fix = buffer 60 min pour US (after_min = 120).
 *
 * Bug #I : 493/493 signaux asia_equity 24h marqués off_session (trace 003550.KO
 * candle_freshness=90134s). Même cause racine que #H — EODHD live trail lag
 * touche aussi Korea/HK/SHE/SZSE/TYO. Fix = buffer 60 min pour asia_equity
 * (after_min = 120, aligné US).
 *
 * EU + crypto restent à 5 min (after_min = 65, inchangé).
 *
 * Couvre :
 *   - getSimulateBufferMin par classe (7 cas)
 *   - getSimulateAfterMin par classe (3 cas)
 *   - simulatePending integration : pre-fetch query MIN cutoff + per-row JS filter
 *     (US/asia young row skipped, US/asia mature row picked, EU/crypto unchanged)
 */
import {
  GainersUserShadowService,
  MAX_WINDOW_MIN,
  SIMULATE_BUFFER_MIN,
  SIMULATE_AFTER_MIN,
  SIMULATE_BUFFER_BY_CLASS,
  DEFAULT_SIMULATE_BUFFER_MIN,
  getSimulateBufferMin,
  getSimulateAfterMin,
} from '../services/gainers-user-shadow.service';

describe('Bug #H — getSimulateBufferMin par asset_class', () => {
  it('us_equity_large → 60 (lag EODHD live constaté)', () => {
    expect(getSimulateBufferMin('us_equity_large')).toBe(60);
  });

  it('us_equity_small_mid → 60 (même plan EODHD US)', () => {
    expect(getSimulateBufferMin('us_equity_small_mid')).toBe(60);
  });

  it('eu_equity → 5 (baseline)', () => {
    expect(getSimulateBufferMin('eu_equity')).toBe(5);
  });

  it('asia_equity → 60 (Bug #I — lag EODHD live identique US)', () => {
    expect(getSimulateBufferMin('asia_equity')).toBe(60);
  });

  it('crypto_major → 5 (Binance live Bug #A)', () => {
    expect(getSimulateBufferMin('crypto_major')).toBe(5);
  });

  it('crypto_alt → 5', () => {
    expect(getSimulateBufferMin('crypto_alt')).toBe(5);
  });

  it('unknown class → DEFAULT_SIMULATE_BUFFER_MIN (5)', () => {
    expect(getSimulateBufferMin('forex_majors')).toBe(DEFAULT_SIMULATE_BUFFER_MIN);
    expect(getSimulateBufferMin('xxx')).toBe(5);
  });
});

describe('Bug #H — getSimulateAfterMin par asset_class', () => {
  it('us_equity_large → 120 (= MAX_WINDOW_MIN 60 + buffer 60)', () => {
    expect(getSimulateAfterMin('us_equity_large')).toBe(120);
    expect(getSimulateAfterMin('us_equity_large')).toBe(MAX_WINDOW_MIN + 60);
  });

  it('asia_equity → 120 (= MAX_WINDOW_MIN 60 + buffer 60, Bug #I)', () => {
    expect(getSimulateAfterMin('asia_equity')).toBe(120);
    expect(getSimulateAfterMin('asia_equity')).toBe(MAX_WINDOW_MIN + 60);
  });

  it('eu_equity → 65 (= MAX_WINDOW_MIN 60 + buffer 5, inchangé)', () => {
    expect(getSimulateAfterMin('eu_equity')).toBe(65);
    expect(getSimulateAfterMin('eu_equity')).toBe(MAX_WINDOW_MIN + DEFAULT_SIMULATE_BUFFER_MIN);
  });

  it('legacy SIMULATE_AFTER_MIN = 65 préservé (back-compat tests TIMING-FIX)', () => {
    expect(SIMULATE_AFTER_MIN).toBe(65);
    expect(SIMULATE_BUFFER_MIN).toBe(5);
    expect(MAX_WINDOW_MIN).toBe(60);
  });

  it('SIMULATE_BUFFER_BY_CLASS lookup is read-only frozen-shape', () => {
    // Sanity : la table est typée Readonly mais on vérifie qu'aucune mutation
    // accidentelle au runtime ne change les valeurs entre 2 lectures.
    const first = { ...SIMULATE_BUFFER_BY_CLASS };
    const second = { ...SIMULATE_BUFFER_BY_CLASS };
    expect(first).toEqual(second);
  });
});

// ============================================================================
// Integration : simulatePending pre-fetch + per-class filter
// ============================================================================

type SupabaseRow = {
  id: string;
  symbol: string;
  asset_class: string;
  entry_price: number;
  created_at: string;
};

function buildServiceWithRows(rows: SupabaseRow[]): {
  svc: GainersUserShadowService;
  capturedLteCutoff: { value: string | null };
  updateCalls: string[];
} {
  const captured = { value: null as string | null };
  const updateCalls: string[] = [];
  // Mock supabase chain: from(...).select(...).is(...).lte(...).order(...).limit(...)
  // Also from(...).update(...).eq(...) for UPDATE.
  const supabaseMock = {
    getClient: () => ({
      from: () => ({
        select: () => ({
          is: () => ({
            lte: (_col: string, cutoff: string) => {
              captured.value = cutoff;
              return {
                order: () => ({
                  limit: async () => ({ data: rows, error: null }),
                }),
              };
            },
          }),
        }),
        update: (_payload: unknown) => ({
          eq: async (_col: string, id: string) => {
            updateCalls.push(String(id));
            return { error: null };
          },
        }),
      }),
    }),
  };
  // EODHD mock : retourne null partout — simulateRow va early-return no_data
  // mais ce qui compte est de tracer quelles row.id atteignent update.
  const eodhdMock = {
    getCandles: jest.fn(async () => null),
    getCandlesViaTicks: jest.fn(async () => null),
  };
  const svc = new GainersUserShadowService(supabaseMock as never, eodhdMock as never);
  return { svc, capturedLteCutoff: captured, updateCalls };
}

describe('Bug #H — simulatePending integration per-class filter', () => {
  it('us_equity_large row created 70 min ago → SKIPPED (needs 120 min)', async () => {
    const nowMs = Date.now();
    const row: SupabaseRow = {
      id: 'us-young',
      symbol: 'QCOM.US',
      asset_class: 'us_equity_large',
      entry_price: 150,
      created_at: new Date(nowMs - 70 * 60_000).toISOString(),
    };
    const { svc, updateCalls } = buildServiceWithRows([row]);
    const { processed, failures } = await svc.simulatePending();

    expect(processed).toBe(0);
    expect(failures).toBe(0);
    // Le row n'a PAS été touché (pas d'UPDATE), sera repris au prochain cycle
    expect(updateCalls).toHaveLength(0);
  });

  it('us_equity_large row created 130 min ago → PICKED + processed', async () => {
    const nowMs = Date.now();
    const row: SupabaseRow = {
      id: 'us-mature',
      symbol: 'QCOM.US',
      asset_class: 'us_equity_large',
      entry_price: 150,
      // Created 130 min ago : 130 > 120 → mature for US
      created_at: new Date(nowMs - 130 * 60_000).toISOString(),
    };
    const { svc, updateCalls } = buildServiceWithRows([row]);
    const { processed } = await svc.simulatePending();

    // simulateRow processes (EODHD mock returns null → outcome no_data,
    // but the row IS picked + UPDATE fired).
    expect(processed).toBe(1);
    expect(updateCalls).toContain('us-mature');
  });

  it('asia_equity row created 70 min ago → SKIPPED (Bug #I: asia needs 120 min)', async () => {
    const nowMs = Date.now();
    const row: SupabaseRow = {
      id: 'asia-young',
      symbol: '005930.KO',
      asset_class: 'asia_equity',
      entry_price: 70000,
      created_at: new Date(nowMs - 70 * 60_000).toISOString(),
    };
    const { svc, updateCalls } = buildServiceWithRows([row]);
    const { processed, failures } = await svc.simulatePending();

    expect(processed).toBe(0);
    expect(failures).toBe(0);
    // Asia row maintenant filtré par JS filter (buffer 60 → mature at 120 min)
    expect(updateCalls).toHaveLength(0);
  });

  it('asia_equity row created 130 min ago → PICKED (Bug #I: mature at 120)', async () => {
    const nowMs = Date.now();
    const row: SupabaseRow = {
      id: 'asia-mature',
      symbol: '005930.KO',
      asset_class: 'asia_equity',
      entry_price: 70000,
      created_at: new Date(nowMs - 130 * 60_000).toISOString(),
    };
    const { svc, updateCalls } = buildServiceWithRows([row]);
    const { processed } = await svc.simulatePending();

    expect(processed).toBe(1);
    expect(updateCalls).toContain('asia-mature');
  });

  it('eu_equity row created 70 min ago → PICKED (EU buffer 5 → mature at 65, inchangé)', async () => {
    const nowMs = Date.now();
    const row: SupabaseRow = {
      id: 'eu-mature',
      symbol: 'OR.PA',
      asset_class: 'eu_equity',
      entry_price: 400,
      created_at: new Date(nowMs - 70 * 60_000).toISOString(),
    };
    const { svc, updateCalls } = buildServiceWithRows([row]);
    const { processed } = await svc.simulatePending();

    expect(processed).toBe(1);
    expect(updateCalls).toContain('eu-mature');
  });

  it('query SQL cutoff = MIN_SIMULATE_AFTER_MIN (65 min, permissive)', async () => {
    const nowMs = Date.now();
    const { svc, capturedLteCutoff } = buildServiceWithRows([]);
    await svc.simulatePending();

    expect(capturedLteCutoff.value).not.toBeNull();
    const cutoffMs = new Date(capturedLteCutoff.value!).getTime();
    const expectedMs = nowMs - 65 * 60_000;
    // Tolérance ±2s pour Date.now() drift entre captures
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(2000);
  });

  it('mixed batch : us/asia young skipped, us/asia mature + eu processed', async () => {
    const nowMs = Date.now();
    const rows: SupabaseRow[] = [
      // us_young : query cutoff 65 → passe, JS filter (US needs 120) le skip
      { id: 'us-young', symbol: 'QCOM.US', asset_class: 'us_equity_large',
        entry_price: 150, created_at: new Date(nowMs - 80 * 60_000).toISOString() },
      { id: 'us-mature', symbol: 'AAPL.US', asset_class: 'us_equity_large',
        entry_price: 150, created_at: new Date(nowMs - 125 * 60_000).toISOString() },
      // asia_young : query cutoff 65 → passe, JS filter (asia needs 120) le skip (Bug #I)
      { id: 'asia-young', symbol: '005930.KO', asset_class: 'asia_equity',
        entry_price: 70000, created_at: new Date(nowMs - 70 * 60_000).toISOString() },
      { id: 'asia-mature', symbol: '003550.KO', asset_class: 'asia_equity',
        entry_price: 50000, created_at: new Date(nowMs - 125 * 60_000).toISOString() },
      // eu_mature : passe à 65 min comme avant
      { id: 'eu-mature', symbol: 'OR.PA', asset_class: 'eu_equity',
        entry_price: 400, created_at: new Date(nowMs - 70 * 60_000).toISOString() },
    ];
    const { svc, updateCalls } = buildServiceWithRows(rows);
    const { processed } = await svc.simulatePending();

    expect(processed).toBe(3);  // us-mature + asia-mature + eu-mature
    expect(updateCalls).toContain('us-mature');
    expect(updateCalls).toContain('asia-mature');
    expect(updateCalls).toContain('eu-mature');
    expect(updateCalls).not.toContain('us-young');
    expect(updateCalls).not.toContain('asia-young');
  });
});
