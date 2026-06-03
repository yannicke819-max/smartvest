/**
 * Funnel TRADER aujourd'hui seulement (00:00 UTC → now).
 * Cible : identifier ce qui a bloqué les 11 premières heures.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const sinceUtcMidnight = new Date(); sinceUtcMidnight.setUTCHours(0, 0, 0, 0);
const since = sinceUtcMidnight.toISOString();

async function paginate(table: string, builder: (q: any) => any): Promise<any[]> {
  const all: any[] = []; let from = 0;
  while (true) {
    const { data } = await builder(sb.from(table)).range(from, from + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

function hourBucket(iso: string): string { return iso.slice(11, 13); }

(async () => {
  console.log(`\n========== TRADER FUNNEL AUJOURD'HUI — depuis 00:00 UTC ==========\n`);

  // Décisions trader by hour
  const dec = await paginate('trader_agent_decisions', (q) =>
    q.select('decided_at, action_kind, target_symbol, gemini_provider, thesis').gte('decided_at', since).order('decided_at', { ascending: true })
  );
  const byHour: Record<string, Record<string, number>> = {};
  for (const r of dec) {
    const h = hourBucket(r.decided_at);
    byHour[h] = byHour[h] ?? {};
    byHour[h][r.action_kind ?? 'null'] = (byHour[h][r.action_kind ?? 'null'] ?? 0) + 1;
  }
  console.log(`--- TRADER DECISIONS aujourd'hui par heure UTC: ${dec.length} ---`);
  console.log('hour  hold  open  scale  trail close null  total  cands_visible');
  for (const h of Object.keys(byHour).sort()) {
    const s = byHour[h];
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    console.log(`${h}:00${String(s.hold ?? 0).padStart(6)}${String(s.open_directional ?? 0).padStart(6)}${String(s.scale_in ?? 0).padStart(7)}${String(s.trail_stop ?? 0).padStart(6)}${String(s.close ?? 0).padStart(6)}${String(s.null ?? 0).padStart(5)}${String(total).padStart(7)}`);
  }

  // Mistral hold thesis sampling
  const holds = dec.filter((d) => d.action_kind === 'hold' && d.gemini_provider);
  const skipEmpty = holds.filter((h) => String(h.thesis ?? '').includes('SKIP_LLM_EMPTY_CONTEXT')).length;
  const cycleTick = holds.filter((h) => String(h.thesis ?? '').includes('CYCLE_TICK')).length;
  const realHold = holds.length - skipEmpty - cycleTick;
  console.log(`\n--- HOLD analysis (${holds.length} total holds) ---`);
  console.log(`  SKIP_LLM_EMPTY_CONTEXT (pas de candidats + 0 position) : ${skipEmpty}`);
  console.log(`  CYCLE_TICK (cron fired, no decision)                    : ${cycleTick}`);
  console.log(`  Mistral hold décisions réelles                          : ${realHold}`);

  // Sample 5 real Mistral hold thesis
  const realHolds = holds.filter((h) => !String(h.thesis ?? '').includes('SKIP_LLM_EMPTY_CONTEXT') && !String(h.thesis ?? '').includes('CYCLE_TICK'));
  console.log(`\n--- Sample 8 vrais hold Mistral (pourquoi pas open ?) ---`);
  for (const h of realHolds.slice(0, 8)) {
    console.log(`  ${h.decided_at.slice(11, 19)} prov=${h.gemini_provider} "${String(h.thesis ?? '').slice(0, 180)}"`);
  }

  // Scanner proposals
  const props = await paginate('scanner_proposals', (q) =>
    q.select('created_at, symbol, status, score, trader_decision_reason').eq('portfolio_id', TRADER).gte('created_at', since).order('created_at', { ascending: true })
  );
  console.log(`\n--- SCANNER_PROPOSALS aujourd'hui: ${props.length} ---`);
  const propByHour: Record<string, number> = {};
  for (const p of props) {
    const h = hourBucket(p.created_at);
    propByHour[h] = (propByHour[h] ?? 0) + 1;
  }
  console.log('par heure :', propByHour);

  // Position open failed today
  const dl = await paginate('lisa_decision_log', (q) =>
    q.select('timestamp, kind, payload').eq('portfolio_id', TRADER).gte('timestamp', since).eq('kind', 'position_open_failed').order('timestamp', { ascending: true })
  );
  console.log(`\n--- POSITION_OPEN_FAILED aujourd'hui: ${dl.length} ---`);
  const byHourFail: Record<string, number> = {};
  for (const r of dl) {
    const h = hourBucket(r.timestamp);
    byHourFail[h] = (byHourFail[h] ?? 0) + 1;
  }
  console.log('par heure :', byHourFail);

  // Mistral skip empty context by hour — to see if upstream filters too aggressively
  const skipByHour: Record<string, number> = {};
  for (const h of holds.filter((x) => String(x.thesis ?? '').includes('SKIP_LLM_EMPTY_CONTEXT'))) {
    const hr = hourBucket(h.decided_at);
    skipByHour[hr] = (skipByHour[hr] ?? 0) + 1;
  }
  console.log(`\n--- SKIP_LLM_EMPTY_CONTEXT par heure: ${skipEmpty} ---`);
  console.log(skipByHour);
})();
