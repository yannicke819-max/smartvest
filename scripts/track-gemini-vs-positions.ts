/**
 * Track Gemini RM/Scout vs positions ouvertes en temps réel.
 *
 * Poll toutes les 60s :
 *   1. Snapshot 9 positions actuelles (entry, sl, tp, status)
 *   2. Live price (via /lisa/debug/live-price si dispo, sinon Supabase realtime)
 *   3. PnL réalisé vs unrealized
 *   4. Events Gemini decision_log (risk_manager_thesis_broken, risk_monitor_action,
 *      opportunity_scout, event_narrative)
 *   5. Comparaison : qu'est-ce que Gemini "voit" vs what's actually in DB
 *
 * Sortie : ligne par ligne en console + alerte sur action Gemini (auto-close).
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);
const PID = 'b0000001-0000-0000-0000-000000000001';
const POLL_INTERVAL_MS = 60_000;
const MAX_DURATION_MIN = 180; // 3h max

interface Position {
  id: string;
  symbol: string;
  direction: string;
  asset_class: string;
  entry_price: number;
  entry_notional_usd: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  entry_timestamp: string;
}

interface GeminiEvent {
  timestamp: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown> | null;
}

const seenEventIds = new Set<string>();
const startedAt = Date.now();

async function snapshotPositions(): Promise<Position[]> {
  const { data } = await sb
    .from('lisa_positions')
    .select('id, symbol, direction, asset_class, entry_price, entry_notional_usd, stop_loss_price, take_profit_price, entry_timestamp')
    .eq('portfolio_id', PID)
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: false });
  return (data ?? []) as Position[];
}

async function fetchGeminiEvents(since: string): Promise<GeminiEvent[]> {
  const { data } = await sb
    .from('lisa_decision_log')
    .select('id, timestamp, kind, summary, payload')
    .eq('portfolio_id', PID)
    .gte('timestamp', since)
    .or('kind.like.%risk_manager%,kind.like.%opportunity_scout%,kind.like.%narrative%,kind.like.%gemini%,kind.like.%risk_monitor%,kind.like.%position_closed%,kind.like.%news_shock%')
    .order('timestamp', { ascending: false });
  return ((data ?? []) as Array<GeminiEvent & { id: string }>).filter((e) => {
    if (seenEventIds.has(e.id)) return false;
    seenEventIds.add(e.id);
    return true;
  });
}

async function fetchClosedSince(since: string): Promise<Array<{ symbol: string; closed_at: string; status: string; realized_pnl_usd: number | null; exit_reason: string | null }>> {
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, closed_at, status, realized_pnl_usd, exit_reason')
    .eq('portfolio_id', PID)
    .gte('closed_at', since)
    .neq('status', 'open');
  return (data ?? []);
}

function fmtPnl(pnl: number | null): string {
  if (pnl === null || !Number.isFinite(pnl)) return '       n/a';
  const s = pnl >= 0 ? '+' : '';
  return `${s}$${pnl.toFixed(2).padStart(7)}`;
}

async function fetchAgentEventsPerPosition(symbol: string, since: string): Promise<GeminiEvent[]> {
  const { data } = await sb
    .from('lisa_decision_log')
    .select('id, timestamp, kind, summary, payload')
    .eq('portfolio_id', PID)
    .gte('timestamp', since)
    .ilike('summary', `%${symbol}%`)
    .order('timestamp', { ascending: false })
    .limit(20);
  return (data ?? []) as GeminiEvent[];
}

async function runOnce(snapshotStart: string, baseline: Map<string, Position>): Promise<{ stop: boolean }> {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\n──── ${ts} UTC ────`);

  // 1. Open positions
  const positions = await snapshotPositions();
  const baselineKeys = new Set(Array.from(baseline.keys()));

  // 2. Closed since start
  const closed = await fetchClosedSince(snapshotStart);
  const newlyClosed = closed.filter((c) =>
    baselineKeys.has(c.symbol + '|' + (baseline.get(c.symbol)?.direction ?? '')),
  );

  if (newlyClosed.length > 0) {
    console.log(`\n🔔 POSITION CLOSED:`);
    for (const c of newlyClosed) {
      console.log(`   ${c.symbol.padEnd(15)} status=${(c.status ?? '').padEnd(20)} pnl=${fmtPnl(c.realized_pnl_usd)} reason=${c.exit_reason ?? '-'}`);
    }
  }

  // 3. Gemini events since start (global)
  const events = await fetchGeminiEvents(snapshotStart);
  if (events.length > 0) {
    console.log(`\n📡 ${events.length} NEW GLOBAL GEMINI EVENTS:`);
    for (const e of events) {
      const tag =
        e.kind.includes('thesis_broken') ? '⚠️ ' :
        e.kind.includes('opportunity') ? '🎯' :
        e.kind.includes('narrative') ? '📰' :
        e.kind.includes('risk_monitor') ? '🛡️ ' :
        e.kind.includes('news_shock') ? '⚡' :
        e.kind.includes('closed') ? '✅' : '  ';
      console.log(`   ${tag} ${e.timestamp.slice(11, 19)} [${e.kind}] ${(e.summary ?? '').slice(0, 100)}`);
      if (e.kind.includes('thesis_broken') && e.payload) {
        const p = e.payload as { confidence?: number; reason?: string; auto_closed?: boolean };
        console.log(`      conf=${p.confidence?.toFixed(2)} reason="${p.reason}" auto_closed=${p.auto_closed}`);
      }
    }
  }

  // 4. PER-POSITION agent attitudes (NEW)
  if (positions.length > 0) {
    console.log(`\n👥 AGENT ATTITUDE PAR POSITION (events ce poll uniquement):`);
    // dedup symbol+dir (009190.KO ouvert long ET short — on regroupe)
    const symbolSet = Array.from(new Set(positions.map((p) => p.symbol)));
    for (const sym of symbolSet) {
      const posSet = positions.filter((p) => p.symbol === sym);
      const dirs = posSet.map((p) => p.direction).join('+');
      const agentEvents = await fetchAgentEventsPerPosition(sym, snapshotStart);
      const recent = agentEvents.filter((e) => !seenEventIds.has(`pos_${e.id}`));
      for (const e of recent) seenEventIds.add(`pos_${e.id}`);
      console.log(`\n   ▸ ${sym} (${dirs})`);
      if (recent.length === 0) {
        console.log(`     (aucun nouvel event agent depuis le dernier poll)`);
      } else {
        for (const e of recent.slice(0, 5)) {
          const k = e.kind.padEnd(30);
          console.log(`     ${e.timestamp.slice(11, 19)}  ${k}  ${(e.summary ?? '').slice(0, 90)}`);
          // Payload détails pour les events clés
          if (e.payload) {
            const p = e.payload as Record<string, unknown>;
            if (p.verdict) console.log(`        → verdict=${p.verdict} confidence=${p.confidence ?? '?'}`);
            if (p.consensus_ratio) console.log(`        → consensus=${p.consensus_ratio} agents=${p.agent_count}`);
            if (p.reason) console.log(`        → reason="${String(p.reason).slice(0, 80)}"`);
          }
        }
      }
    }
  }

  // 5. Position recap
  console.log(`\n💼 ${positions.length} OPEN / ${closed.length} CLOSED depuis ${snapshotStart.slice(11, 16)}`);
  if (closed.length > 0) {
    const totalPnl = closed.reduce((s, c) => s + (Number(c.realized_pnl_usd) || 0), 0);
    console.log(`   Realized PnL: ${fmtPnl(totalPnl)} (${closed.length} trades fermés)`);
  }

  // Stop if all closed or max duration
  const minutesElapsed = (Date.now() - startedAt) / 60_000;
  if (positions.length === 0 && baseline.size > 0) {
    console.log(`\n✅ All positions closed (was ${baseline.size}). Stopping.`);
    return { stop: true };
  }
  if (minutesElapsed >= MAX_DURATION_MIN) {
    console.log(`\n⏱️ Max duration ${MAX_DURATION_MIN}min reached. Stopping.`);
    return { stop: true };
  }
  return { stop: false };
}

async function main() {
  console.log(`=== Gemini vs Positions Tracker ===`);
  console.log(`Portfolio : ${PID}`);
  console.log(`Poll      : every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Max       : ${MAX_DURATION_MIN} min`);

  const baseline = await snapshotPositions();
  if (baseline.length === 0) {
    console.log(`\n⚠️  Aucune position ouverte au start.`);
  }
  const baselineMap = new Map(baseline.map((p) => [p.symbol, p]));
  const snapshotStart = new Date().toISOString();
  console.log(`\n=== BASELINE @ ${snapshotStart.slice(11, 19)} UTC ===`);
  for (const p of baseline) {
    console.log(`  ${p.symbol.padEnd(15)} ${p.direction.padEnd(8)} entry=${p.entry_price.toString().padStart(10)} notional=$${p.entry_notional_usd} SL=${p.stop_loss_price} TP=${p.take_profit_price}`);
  }

  // Pour chaque position : pull les events d'ouverture (debate, conviction, td filters, position_opened)
  console.log(`\n=== AGENT VERDICTS À L'OUVERTURE ===`);
  const symbolSet = Array.from(new Set(baseline.map((p) => p.symbol)));
  for (const sym of symbolSet) {
    const dirs = baseline.filter((p) => p.symbol === sym).map((p) => p.direction).join('+');
    console.log(`\n  ▸ ${sym} (${dirs})`);
    const { data: openingEvents } = await sb
      .from('lisa_decision_log')
      .select('timestamp, kind, summary, payload')
      .eq('portfolio_id', PID)
      .ilike('summary', `%${sym}%`)
      .gte('timestamp', '2026-05-26T04:25:00Z')
      .lte('timestamp', snapshotStart)
      .order('timestamp', { ascending: true });
    if (!openingEvents || openingEvents.length === 0) {
      console.log(`    (aucun event audit trouvé pour cette ouverture)`);
      continue;
    }
    for (const e of openingEvents) {
      console.log(`    ${e.timestamp.slice(11, 19)}  [${e.kind.padEnd(28)}]  ${(e.summary ?? '').slice(0, 100)}`);
      if (e.payload) {
        const p = e.payload as Record<string, unknown>;
        const tags: string[] = [];
        if (p.conviction_score !== undefined) tags.push(`conv=${p.conviction_score}`);
        if (p.score !== undefined) tags.push(`score=${p.score}`);
        if (p.persistence_score !== undefined) tags.push(`persistence=${p.persistence_score}`);
        if (p.path_eff !== undefined) tags.push(`pathEff=${p.path_eff}`);
        if (p.change_pct !== undefined) tags.push(`ch=${p.change_pct}%`);
        if (p.verdict) tags.push(`verdict=${p.verdict}`);
        if (p.notional_usd) tags.push(`notional=$${p.notional_usd}`);
        if (tags.length) console.log(`         → ${tags.join('  ')}`);
      }
    }
  }
  console.log(`\n=== POLL EN CONTINU (toutes les ${POLL_INTERVAL_MS / 1000}s) ===`);

  while (true) {
    try {
      const { stop } = await runOnce(snapshotStart, baselineMap);
      if (stop) break;
    } catch (e) {
      console.error(`[poll error] ${String(e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
