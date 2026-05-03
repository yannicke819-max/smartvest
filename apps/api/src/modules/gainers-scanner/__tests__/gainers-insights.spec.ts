/**
 * Phase A — GainersInsightsService specs.
 *
 * Mock SupabaseClient avec un fake table store en mémoire.
 */

import { GainersInsightsService } from '../insights/gainers-insights.service';

function makeMockSupabase() {
  const rows: any[] = [];
  let nextId = 0;

  const builder = (tableName: string): any => {
    let _filters: Array<{ field: string; op: string; value: unknown }> = [];
    let _patch: Record<string, unknown> | null = null;
    let _select: string | null = null;
    let _limit: number | null = null;
    let _orderBy: { field: string; ascending: boolean } | null = null;
    let _gteValue: { field: string; value: string } | null = null;
    let _insert: Record<string, unknown> | null = null;
    let _operation: 'select' | 'insert' | 'update' | null = null;

    const obj: any = {
      select(s: string) { _select = s; _operation = _operation ?? 'select'; return obj; },
      insert(payload: Record<string, unknown>) { _insert = { ...payload }; _operation = 'insert'; return obj; },
      update(patch: Record<string, unknown>) { _patch = patch; _operation = 'update'; return obj; },
      eq(field: string, value: unknown) { _filters.push({ field, op: 'eq', value }); return obj; },
      gte(field: string, value: string) { _gteValue = { field, value }; return obj; },
      order(field: string, opts: { ascending: boolean }) { _orderBy = { field, ascending: opts.ascending }; return obj; },
      limit(n: number) { _limit = n; return obj; },
      single() {
        if (_operation === 'insert' && _insert) {
          const row = { id: `id-${nextId++}`, created_at: new Date().toISOString(), ..._insert };
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'unexpected single()' } });
      },
      then(resolve: any) {
        // For await on update or select chain
        if (_operation === 'update' && _patch) {
          for (const r of rows) {
            const matches = _filters.every((f) => r[f.field] === f.value);
            if (matches) Object.assign(r, _patch);
          }
          return resolve({ data: null, error: null });
        }
        if (_operation === 'select') {
          let out = rows.slice();
          if (_gteValue) out = out.filter((r) => r[_gteValue!.field] >= _gteValue!.value);
          for (const f of _filters) out = out.filter((r) => r[f.field] === f.value);
          if (_orderBy) {
            out.sort((a, b) => (a[_orderBy!.field] < b[_orderBy!.field] ? 1 : -1) * (_orderBy!.ascending ? -1 : 1));
          }
          if (_limit !== null) out = out.slice(0, _limit);
          return resolve({ data: out, error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return obj;
  };

  return {
    getClient: () => ({
      from: (table: string) => builder(table),
    }),
    _rows: rows,
  } as any;
}

describe('GainersInsightsService', () => {
  it('logs an insight and returns id', async () => {
    const supabase = makeMockSupabase();
    const svc = new GainersInsightsService(supabase);
    const id = await svc.logInsight({
      type: 'divergence_analysis',
      source: 'session_chat',
      summary: 'V1 plus prudente que legacy sur 3 cas Asia weekend',
      payload: { divergence_count: 3, symbols: ['059120', '000783', 'DWARKESH'] },
      severity: 'info',
    });
    expect(id).toBeTruthy();
    expect(supabase._rows.length).toBe(1);
    expect(supabase._rows[0].insight_type).toBe('divergence_analysis');
    expect(supabase._rows[0].status).toBe('open');
    expect(supabase._rows[0].severity).toBe('info');
  });

  it('clamps summary to 500 chars', async () => {
    const supabase = makeMockSupabase();
    const svc = new GainersInsightsService(supabase);
    const longSummary = 'x'.repeat(800);
    await svc.logInsight({
      type: 'manual_observation',
      source: 'manual',
      summary: longSummary,
      payload: {},
    });
    expect(supabase._rows[0].summary.length).toBe(500);
  });

  it('queries with filters', async () => {
    const supabase = makeMockSupabase();
    const svc = new GainersInsightsService(supabase);
    await svc.logInsight({ type: 'divergence_analysis', source: 'session_chat', summary: 's1', payload: {} });
    await svc.logInsight({ type: 'cadence_drift', source: 'auto_drift_detector', summary: 's2', payload: {}, severity: 'high' });
    await svc.logInsight({ type: 'divergence_analysis', source: 'manual', summary: 's3', payload: {} });

    const all = await svc.queryInsights({ sinceDays: 30 });
    expect(all.length).toBe(3);

    const divergences = await svc.queryInsights({ type: 'divergence_analysis' });
    expect(divergences.length).toBe(2);

    const high = await svc.queryInsights({ severity: 'high' });
    expect(high.length).toBe(1);
    expect(high[0].insight_type).toBe('cadence_drift');
  });

  it('resolveInsight updates status + resolution metadata', async () => {
    const supabase = makeMockSupabase();
    const svc = new GainersInsightsService(supabase);
    const id = await svc.logInsight({ type: 'pipeline_bug', source: 'manual', summary: 'BTC mislabeled', payload: {} });
    const ok = await svc.resolveInsight(id!, {
      status: 'actioned',
      resolution: 'PR6.6.2 wired asset_class',
      resolutionPr: 'yannicke819-max/smartvest#218',
      resolvedBy: 'session-chat',
    });
    expect(ok).toBe(true);
    expect(supabase._rows[0].status).toBe('actioned');
    expect(supabase._rows[0].resolution_pr).toBe('yannicke819-max/smartvest#218');
    expect(supabase._rows[0].resolved_at).toBeTruthy();
  });

  it('getStats aggregates by type/status/severity', async () => {
    const supabase = makeMockSupabase();
    const svc = new GainersInsightsService(supabase);
    await svc.logInsight({ type: 'divergence_analysis', source: 'session_chat', summary: 's1', payload: {}, severity: 'info' });
    await svc.logInsight({ type: 'divergence_analysis', source: 'session_chat', summary: 's2', payload: {}, severity: 'low' });
    await svc.logInsight({ type: 'pipeline_bug', source: 'manual', summary: 's3', payload: {}, severity: 'critical' });

    const stats = await svc.getStats(30);
    expect(stats.total).toBe(3);
    expect(stats.byType.divergence_analysis).toBe(2);
    expect(stats.byType.pipeline_bug).toBe(1);
    expect(stats.byStatus.open).toBe(3);
    expect(stats.bySeverity.critical).toBe(1);
  });
});
