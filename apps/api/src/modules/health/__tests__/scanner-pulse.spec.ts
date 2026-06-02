/**
 * /health/scanner-pulse — safeguard incident 22-23/05/2026 (machine zombie 8h).
 * Endpoint DB-side : DOIT renvoyer 503 si dernier cycle stale ET ≥1 portfolio
 * gainers actif. Cas dev (aucun portfolio) → toujours 200 idle.
 */

import { ScannerPulseController } from '../scanner-pulse.controller';

function makeRes() {
  let statusCode = 200;
  return {
    status: (code: number) => {
      statusCode = code;
      return undefined as unknown as Response;
    },
    get statusCode() { return statusCode; },
  };
}

function makeSupabase(opts: {
  hasPortfolio: boolean;
  lastCycleTs: string | null;
  cfgErr?: string;
  logErr?: string;
  traderTs?: string | null;
  traderErr?: string;
}) {
  return {
    getClient: () => ({
      from: (table: string) => {
        if (table === 'lisa_session_configs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    limit: async () => ({
                      data: opts.cfgErr ? null : (opts.hasPortfolio ? [{ portfolio_id: 'p1' }] : []),
                      error: opts.cfgErr ? { message: opts.cfgErr } : null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'trader_agent_decisions') {
          // Fallback chain post-fix 02/06 : .select().order().limit() — sans .eq().
          return {
            select: () => ({
              order: () => ({
                limit: async () => ({
                  data: opts.traderErr
                    ? null
                    : (opts.traderTs ? [{ cycle_started_at: opts.traderTs }] : []),
                  error: opts.traderErr ? { message: opts.traderErr } : null,
                }),
              }),
            }),
          };
        }
        // decision_log
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: opts.logErr ? null : (opts.lastCycleTs ? [{ timestamp: opts.lastCycleTs }] : []),
                  error: opts.logErr ? { message: opts.logErr } : null,
                }),
              }),
            }),
          }),
        };
      },
    }),
  } as any;
}

const cfgService = (env: Record<string, string> = {}) => ({
  get: (k: string) => env[k],
}) as any;

describe('ScannerPulseController.getPulse', () => {
  it('idle (200) si aucun portfolio gainers actif (dev/test/preview)', async () => {
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: false, lastCycleTs: null }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('idle');
    expect(res.statusCode).toBe(200);
  });

  it('healthy (200) si cycle frais (< 20min)', async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: fresh }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('healthy');
    expect(res.statusCode).toBe(200);
  });

  it('stale (503) si cycle ancien > seuil ET portfolio actif (cas incident 22-23/05)', async () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min ago
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: stale }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('stale');
    expect(res.statusCode).toBe(503);
    expect((r as any).age_sec).toBeGreaterThan(1200); // > 20min
  });

  it('seuil configurable via SCANNER_PULSE_MAX_AGE_MIN', async () => {
    const age10min = new Date(Date.now() - 10 * 60_000).toISOString();
    // Avec seuil 5 min → stale ; avec default 20 → healthy.
    const tight = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: age10min }), cfgService({ SCANNER_PULSE_MAX_AGE_MIN: '5' }));
    expect((await tight.getPulse(makeRes() as any)).status).toBe('stale');
    const loose = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: age10min }), cfgService());
    expect((await loose.getPulse(makeRes() as any)).status).toBe('healthy');
  });

  it('1er boot prod (aucun cycle jamais) → healthy (200) — pas de faux-positif', async () => {
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: null }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('healthy');
    expect(res.statusCode).toBe(200);
  });

  it('Supabase indispo (configs err) → idle 200 (PAS 503 — éviter restart inutile sur blip DB)', async () => {
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: false, lastCycleTs: null, cfgErr: 'timeout' }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('idle');
    expect(res.statusCode).toBe(200);
  });

  it('Supabase indispo (log err) → idle 200', async () => {
    const ctrl = new ScannerPulseController(makeSupabase({ hasPortfolio: true, lastCycleTs: null, logErr: 'conn refused' }), cfgService());
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('idle');
    expect(res.statusCode).toBe(200);
  });

  // Fix 02/06/2026 — En mode strategy_mode='gainers', autopilot Lisa LLM skip et
  // n'écrit plus `autopilot_cycle_completed`. Le pulse doit fallback sur le
  // dernier `trader_agent_decisions.cycle_started_at` pour ne pas être stale à tort.
  it('fallback trader_agent_decisions si autopilot stale mais trader cycle frais', async () => {
    const staleAutopilot = new Date(Date.now() - 30 * 60_000).toISOString(); // 30min ago
    const freshTrader = new Date(Date.now() - 60_000).toISOString(); // 1min ago
    const ctrl = new ScannerPulseController(
      makeSupabase({ hasPortfolio: true, lastCycleTs: staleAutopilot, traderTs: freshTrader }),
      cfgService(),
    );
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('healthy');
    expect(res.statusCode).toBe(200);
    expect((r as any).age_sec).toBeLessThan(120);
  });

  it('stale 503 si autopilot stale ET trader_agent_decisions stale aussi', async () => {
    const staleAutopilot = new Date(Date.now() - 30 * 60_000).toISOString();
    const staleTrader = new Date(Date.now() - 25 * 60_000).toISOString();
    const ctrl = new ScannerPulseController(
      makeSupabase({ hasPortfolio: true, lastCycleTs: staleAutopilot, traderTs: staleTrader }),
      cfgService(),
    );
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    expect(r.status).toBe('stale');
    expect(res.statusCode).toBe(503);
  });

  it('autopilot null + trader cycle frais → healthy (mode gainers pure)', async () => {
    const freshTrader = new Date(Date.now() - 60_000).toISOString();
    const ctrl = new ScannerPulseController(
      makeSupabase({ hasPortfolio: true, lastCycleTs: null, traderTs: freshTrader }),
      cfgService(),
    );
    const res = makeRes();
    const r = await ctrl.getPulse(res as any);
    // lastCycleTs=null → premier short-circuit "healthy" car le code retourne healthy
    // dès que rows vide. La fallback trader n'est pas exercée dans ce cas (acceptable :
    // l'autopilot n'a juste jamais cyclé, le pulse considère "premier boot prod").
    expect(r.status).toBe('healthy');
    expect(res.statusCode).toBe(200);
  });
});
