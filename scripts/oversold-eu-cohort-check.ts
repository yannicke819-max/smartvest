/**
 * Tracker de cohorte OVERSOLD EU — suit les positions scanner_oversold ouvertes
 * et confronte leur rebond RÉEL à la loi empirique par bande de drop
 * (docs/mode-oversold-spec.md : -5/-8% → +1% alpha J+10, -8/-12% → +2,45%).
 *
 * Usage (n'importe quel jour jusqu'à J+10) :
 *   npx tsx scripts/oversold-eu-cohort-check.ts
 *
 * Sortie : par position → drop d'entrée, bande, alpha J+10 attendu, jours tenus /
 * restants, move réalisé depuis l'entrée, + régime (VIX/DAX) pour lire l'absolu
 * vs le relatif (l'alpha est vs indice ; un marché baissier efface l'absolu).
 *
 * Lecture seule (EODHD + Supabase). Aucun effet sur le trading.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = process.env.EODHD_API_KEY!;
const HOLD_DAYS = 10;

interface Pos {
  symbol: string;
  entry_price: number;
  entry_timestamp: string;
  stop_loss_price: number | null;
  portfolio_id: string;
}

/** Bande de drop → alpha J+10 historique (backtest fondateur, vs indice). */
function bandAlpha(dropPct: number): { band: string; alpha: number | null } {
  if (dropPct > -3) return { band: '>-3% (pas signal)', alpha: null };
  if (dropPct > -5) return { band: '-3/-5%', alpha: 0 };
  if (dropPct > -8) return { band: '-5/-8%', alpha: 1.0 };
  if (dropPct >= -12) return { band: '-8/-12%', alpha: 2.45 };
  return { band: '<-12% (falling-knife)', alpha: -1.97 };
}

function addBusinessDays(d: Date, n: number): Date {
  const r = new Date(d);
  let added = 0;
  while (added < n) {
    r.setUTCDate(r.getUTCDate() + 1);
    const dow = r.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return r;
}

function businessDaysBetween(a: Date, b: Date): number {
  let n = 0;
  const r = new Date(a);
  r.setUTCHours(0, 0, 0, 0);
  const end = new Date(b);
  end.setUTCHours(0, 0, 0, 0);
  while (r < end) {
    r.setUTCDate(r.getUTCDate() + 1);
    const dow = r.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

async function realtimeBulk(symbols: string[]): Promise<Map<string, { close: number; changeP: number }>> {
  const out = new Map<string, { close: number; changeP: number }>();
  if (symbols.length === 0) return out;
  const [first, ...rest] = symbols;
  const s = rest.length ? `&s=${rest.join(',')}` : '';
  const url = `https://eodhd.com/api/real-time/${first}?api_token=${EODHD}&fmt=json${s}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return out;
  let j = await res.json().catch(() => null);
  if (!j) return out;
  if (!Array.isArray(j)) j = [j];
  for (const q of j as Array<{ code?: string; close?: number; change_p?: number }>) {
    if (q.code) out.set(q.code, { close: Number(q.close), changeP: Number(q.change_p) });
  }
  return out;
}

/** EOD history → drop du jour d'entrée + dernier close. */
async function eodEntryDrop(symbol: string, entryDate: Date): Promise<{ entryDayDropPct: number | null; lastClose: number | null }> {
  const from = new Date(entryDate.getTime() - 12 * 86400_000).toISOString().slice(0, 10);
  const url = `https://eodhd.com/api/eod/${symbol}?api_token=${EODHD}&fmt=json&from=${from}&order=a&period=d`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return { entryDayDropPct: null, lastClose: null };
  const bars = (await res.json().catch(() => [])) as Array<{ date: string; close: number }>;
  if (!Array.isArray(bars) || bars.length < 2) return { entryDayDropPct: null, lastClose: null };
  const entryStr = entryDate.toISOString().slice(0, 10);
  // bar du jour d'entrée (ou le dernier <= entryDate) + son précédent
  let idx = bars.findIndex((b) => b.date === entryStr);
  if (idx < 1) {
    for (let i = bars.length - 1; i >= 1; i--) {
      if (bars[i].date <= entryStr) { idx = i; break; }
    }
  }
  const entryDayDropPct = idx >= 1 ? ((bars[idx].close - bars[idx - 1].close) / bars[idx - 1].close) * 100 : null;
  return { entryDayDropPct, lastClose: bars[bars.length - 1].close };
}

async function main() {
  const now = new Date();
  console.log(`\n📉 OVERSOLD EU — TRACKER DE COHORTE vs LOI EMPIRIQUE`);
  console.log(`Date : ${now.toISOString().slice(0, 16)}Z  (${now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} Paris)`);
  console.log('═'.repeat(96));

  // 1. Positions oversold ouvertes (toutes EU/UK : suffixe non-US)
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, entry_price, entry_timestamp, stop_loss_price, portfolio_id, venue_fee_detail')
    .eq('status', 'open');
  const all = (data ?? []) as Array<Pos & { venue_fee_detail: { source?: string } | null }>;
  const cohort = all.filter(
    (p) => (p.venue_fee_detail?.source === 'scanner_oversold') && !p.symbol.endsWith('.US'),
  );
  if (cohort.length === 0) {
    console.log('🟢 Aucune position oversold EU ouverte.');
    return;
  }

  // 2. Régime
  const reg = await realtimeBulk(['VIX.INDX', 'GDAXI.INDX', 'FTSE.INDX']);
  const vix = reg.get('VIX.INDX');
  const dax = reg.get('GDAXI.INDX');
  const ftse = reg.get('FTSE.INDX');
  const fnum = (n: number | undefined, d = 0) => (n != null && Number.isFinite(n) ? n.toFixed(d) : '?');
  const fpct = (q?: { changeP: number }) => (q && Number.isFinite(q.changeP) ? `${q.changeP >= 0 ? '+' : ''}${q.changeP.toFixed(2)}%` : '?');
  console.log(`Régime : VIX ${fnum(vix?.close, 2)} (${fpct(vix)})  ·  DAX ${fnum(dax?.close, 0)} (${fpct(dax)})  ·  FTSE ${fnum(ftse?.close, 0)} (${fpct(ftse)})`);
  const vixHot = vix && vix.close >= 21;
  console.log(vixHot ? '⚠️  VIX élevé (≥21) → risk-off, le bêta peut effacer l\'alpha en absolu.' : '🟢 VIX modéré → contexte favorable au rebond oversold.');
  console.log('─'.repeat(96));

  // 3. Prix courants (real-time)
  const live = await realtimeBulk(cohort.map((p) => p.symbol));

  console.log(
    'Symbole'.padEnd(14) + 'Drop ent.'.padEnd(11) + 'Bande'.padEnd(13) + 'αJ+10'.padEnd(8) +
    'Entrée'.padEnd(11) + 'Actuel'.padEnd(11) + 'Move'.padEnd(9) + 'Tenu/Rest.'.padEnd(12) + 'Échéance',
  );
  console.log('─'.repeat(96));

  const rows: Array<{ band: string; alpha: number | null; move: number | null }> = [];
  for (const p of cohort) {
    const entryDate = new Date(p.entry_timestamp);
    const { entryDayDropPct } = await eodEntryDrop(p.symbol, entryDate);
    const cur = live.get(p.symbol)?.close ?? null;
    const move = cur != null && p.entry_price > 0 ? ((cur - p.entry_price) / p.entry_price) * 100 : null;
    const { band, alpha } = entryDayDropPct != null ? bandAlpha(entryDayDropPct) : { band: '?', alpha: null };
    const held = businessDaysBetween(entryDate, now);
    const remaining = Math.max(0, HOLD_DAYS - held);
    const deadline = addBusinessDays(entryDate, HOLD_DAYS).toISOString().slice(0, 10);
    rows.push({ band, alpha, move });
    console.log(
      p.symbol.padEnd(14) +
      (entryDayDropPct != null ? `${entryDayDropPct.toFixed(1)}%` : '?').padEnd(11) +
      band.padEnd(13) +
      (alpha != null ? `+${alpha}%` : '—').padEnd(8) +
      String(p.entry_price).padEnd(11) +
      (cur != null ? String(cur) : '?').padEnd(11) +
      (move != null ? `${move >= 0 ? '+' : ''}${move.toFixed(2)}%` : '?').padEnd(9) +
      `J+${held}/${HOLD_DAYS}`.padEnd(12) +
      deadline,
    );
  }

  // 4. Synthèse : la loi tient-elle en live ?
  console.log('─'.repeat(96));
  const withMove = rows.filter((r) => r.move != null && r.alpha != null);
  if (withMove.length) {
    const avgMove = withMove.reduce((s, r) => s + (r.move as number), 0) / withMove.length;
    const avgAlpha = withMove.reduce((s, r) => s + (r.alpha as number), 0) / withMove.length;
    console.log(`Move réalisé moyen : ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)}%  vs  alpha J+10 attendu (vs indice) : +${avgAlpha.toFixed(2)}%`);
    console.log('Rappel : le move réalisé est ABSOLU, l\'alpha est RELATIF à l\'indice. Comparer move vs (alpha + perf indice depuis l\'entrée).');
  }
  console.log('═'.repeat(96) + '\n');
}

main().catch((e) => { console.error('cohort-check failed:', e); process.exit(1); });
