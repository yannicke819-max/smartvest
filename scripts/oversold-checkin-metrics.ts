/**
 * oversold-checkin-metrics.ts — LES 4 ROUTINES DE MESURE DU CHECK-IN OVERSOLD.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER EXISTE
 * ─────────────────────────────────────────────────────────────────────────────
 * Au check-in du 06/08/2026, TROIS conclusions nettes se sont révélées FAUSSES
 * après vérification — et toutes les trois pour un défaut de MÉTHODE, pas de
 * données. Elles avaient déjà été commises, en substance, aux sessions
 * précédentes. Écrire les règles dans CLAUDE.md n'a pas suffi : rien n'empêche
 * de réécrire un `filter()` naïf au check-in suivant.
 *
 * Ce fichier fige les versions CORRECTES. Le prochain check-in les APPELLE au
 * lieu de les re-dériver.
 *
 *   1. exposureReplay()      — « le régulateur est cassé » → FAUX (double comptage)
 *   2. lockSweep()           — « +$43k à 4% » → FAUX (la simu ne mourait jamais)
 *   3. classifyExits()       — « le LLM vaut +1 pt » → FAUX (il n'a rien décidé)
 *   4. rebuildIndex5d()      — buckets de régime sur 66% de la population → 100%
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   npx tsx scripts/oversold-checkin-metrics.ts              # les 4 routines
 *   npx tsx scripts/oversold-checkin-metrics.ts exposure     # une seule
 *   npx tsx scripts/oversold-checkin-metrics.ts lock exits
 *
 * Requiert SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ EODHD_API_KEY pour
 * `lock` et `idx5d`).
 *
 * ⚠️ RÈGLE TRANSVERSALE : toute mesure part de `paper_trades` (population
 * COMPLÈTE). Ne JAMAIS partir de `position_close_decisions` — cette table ne
 * contient que les gagnantes lockées, elle a déjà produit trois mirages
 * (« pic J+3 », « pic J+6 », « lessons WR 100% »).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const US = 'a0000001-0000-0000-0000-000000000001';
const EU = 'c0000001-0000-0000-0000-000000000001';
/** Capital par portefeuille — source : lisa_session_configs.capital_usd. */
const CAPITAL: Record<string, number> = { [US]: 150_000, [EU]: 20_000 };
const PORTFOLIOS: Array<[string, string]> = [['US', US], ['EU', EU]];

const HOLD_DAYS = 10;
const CATASTROPHE_PCT = -15;

// ─── utilitaires ─────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const avg = (a: number[]): number | null => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const med = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (a: number[]): number | null => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
const fmt = (v: number | null, d = 2): string => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(d));

function client(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  return createClient(url, key);
}

interface Trade {
  symbol: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
  entry_price: string | null;
  size_usd: string | null;
  pnl_pct: string | null;
  pnl_usd: string | null;
  fwd_return_10d: string | null;
  features_at_entry: Record<string, unknown> | null;
}

/**
 * Charge TOUTE la population oversold d'un portefeuille, avec pagination.
 *
 * ⚠️ PostgREST plafonne à 1000 lignes par requête SANS le signaler. Un `select()`
 * nu renvoie donc un échantillon tronqué qui ressemble à un jeu complet — piège
 * silencieux. D'où la boucle `range()`.
 */
async function allTrades(sb: SupabaseClient, portfolioId: string): Promise<Trade[]> {
  const cols =
    'symbol,opened_at,closed_at,status,entry_price,size_usd,pnl_pct,pnl_usd,fwd_return_10d,features_at_entry';
  const out: Trade[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('paper_trades')
      .select(cols)
      .eq('portfolio_id', portfolioId)
      .eq('strategy', 'oversold')
      .order('opened_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`paper_trades: ${error.message}`);
    out.push(...((data ?? []) as unknown as Trade[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

interface Bar { date: string; high: number; low: number; close: number }

const barCache = new Map<string, Bar[]>();

async function fetchBars(symbol: string, from = '2026-05-01'): Promise<Bar[]> {
  const cached = barCache.get(symbol);
  if (cached) return cached;
  const key = process.env.EODHD_API_KEY;
  if (!key) throw new Error('EODHD_API_KEY manquante');
  let bars: Bar[] = [];
  try {
    const res = await fetch(
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}?api_token=${key}&fmt=json&from=${from}&period=d`,
    );
    if (res.ok) {
      const json = (await res.json()) as Array<Record<string, unknown>>;
      if (Array.isArray(json)) {
        bars = json
          .map((b) => ({
            date: String(b.date ?? ''),
            high: Number(b.high ?? NaN),
            low: Number(b.low ?? NaN),
            close: Number(b.adjusted_close ?? b.close ?? NaN),
          }))
          .filter((b) => b.date.length > 0 && Number.isFinite(b.close));
      }
    }
  } catch {
    bars = [];
  }
  barCache.set(symbol, bars);
  return bars;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTINE 1 — EXPOSITION : replay chronologique
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Exposition CONCURRENTE réelle = capital engagé AU MÊME INSTANT.
 *
 * 🔴 L'ERREUR À NE PLUS REFAIRE (check-in 06/08) — le comptage « par jour » :
 *
 *     const open = pos.filter(p => p.opened_at <= jour+'T23:59'
 *                               && (!p.closed_at || p.closed_at > jour+'T00:00'));
 *
 * Ce filtre compte une position ouverte à 15:00 et lockée à 15:30 pour la
 * JOURNÉE ENTIÈRE. Or la détention médiane oversold est de ~0.3 jour : le
 * capital tourne plusieurs fois par jour, et le même dollar est compté 3-4 fois.
 * Verdict erroné produit : « US 110% moyen, 7 jours > 100% → le régulateur est
 * cassé ». Verdict correct après replay : pic max 100.0%, ZÉRO dépassement.
 *
 * La bonne mesure : +size à l'ouverture, −size à la fermeture, tri par
 * timestamp, somme courante, maximum par jour.
 */
export function exposureReplay(
  trades: Trade[],
  capitalUsd: number,
): Array<{ day: string; peakPct: number; endPct: number }> {
  const events: Array<{ t: string; d: number }> = [];
  for (const p of trades) {
    const size = num(p.size_usd) ?? 0;
    if (!p.opened_at) continue;
    events.push({ t: p.opened_at, d: size });
    if (p.closed_at) events.push({ t: p.closed_at, d: -size });
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  const byDay = new Map<string, number[]>();
  let running = 0;
  for (const e of events) {
    running += e.d;
    const day = e.t.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push((running / capitalUsd) * 100);
    byDay.set(day, arr);
  }
  return [...byDay.entries()]
    .map(([day, utils]) => ({ day, peakPct: Math.max(...utils), endPct: utils[utils.length - 1] }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTINE 2 — BALAYAGE DU SEUIL DE LOCK
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Simule le P&L à différents seuils de lock, jour par jour.
 *
 * 🔴 L'ERREUR À NE PLUS REFAIRE (check-in 06/08) — la simu qui ne meurt jamais :
 *
 *     for (const d of win) { if ((d.high-e)/e*100 >= th) { pct = th; break; } }
 *
 * Elle cherche le plus-haut sur 11 jours SANS jamais appliquer le stop
 * catastrophe. Une position qui descend à −20% le jour 3 puis imprime +4% le
 * jour 8 était comptée +4% — alors qu'elle aurait été fermée à −15% le jour 3.
 * Verdict erroné produit : « +$43k à 4%, 87% de touche ».
 *
 * La bonne simulation, dans cet ordre exact :
 *   1. le BAS de la journée touche −15% → catastrophe (hypothèse conservatrice :
 *      si haut ET bas sont touchés le même jour, on suppose le pire) ;
 *   2. sinon le HAUT touche le seuil → lock ;
 *   3. sinon, à J+10 → close de la dernière barre (deadline).
 *
 * ⚠️ CONTRÔLE DE CALIBRATION OBLIGATOIRE — ne JAMAIS lire les montants sans
 * comparer la simu au seuil ACTUEL au P&L RÉELLEMENT encaissé (`calibration`
 * ci-dessous). Au 06/08 : EU simulé +$3 012 vs réel +$3 187 (erreur −$175, on
 * peut lire les montants) ; US +$39 238 vs +$25 537 (la simu ignore 49 closes
 * manuels + 30 sorties « autres » + 9 deadlines → sur US, ne lire QUE le
 * classement).
 *
 * ⚠️ Deux biais qui restent, à citer dans toute conclusion :
 *   · la simu suppose qu'on capte exactement le plus-haut quotidien, alors que
 *     le gain-picker sonde toutes les 30 s → le gain réel sera INFÉRIEUR ;
 *   · un historique de marché HAUSSIER favorise mécaniquement les seuils hauts.
 */
export interface LockSweepRow {
  threshold: number;
  n: number;
  lockPct: number;
  catastrophePct: number;
  deadlinePct: number;
  avgPct: number | null;
  medPct: number | null;
  avgHoldDays: number | null;
  simulatedPnlUsd: number;
}

export async function lockSweep(
  trades: Trade[],
  thresholds = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 4.0],
): Promise<{ rows: LockSweepRow[]; calibration: { realizedUsd: number } }> {
  const closed = trades.filter((t) => t.status !== 'open' && num(t.entry_price));
  for (const t of closed) await fetchBars(t.symbol);

  const rows: LockSweepRow[] = [];
  for (const th of thresholds) {
    let pnlUsd = 0, n = 0, locks = 0, catas = 0, deadlines = 0;
    const pcts: number[] = [];
    const holds: number[] = [];

    for (const t of closed) {
      const bars = barCache.get(t.symbol) ?? [];
      if (!bars.length) continue;
      const entry = num(t.entry_price);
      if (!entry || entry <= 0) continue;
      const window = bars.filter((b) => b.date >= t.opened_at.slice(0, 10)).slice(0, HOLD_DAYS + 1);
      if (window.length < 2) continue;

      n++;
      let pct: number | null = null;
      let dayIdx = window.length - 1;
      for (let i = 0; i < window.length; i++) {
        const hi = ((window[i].high - entry) / entry) * 100;
        const lo = ((window[i].low - entry) / entry) * 100;
        if (lo <= CATASTROPHE_PCT) { pct = CATASTROPHE_PCT; catas++; dayIdx = i; break; }  // ← le BAS d'abord
        if (hi >= th) { pct = th; locks++; dayIdx = i; break; }
      }
      if (pct == null) { pct = ((window[window.length - 1].close - entry) / entry) * 100; deadlines++; }

      pcts.push(pct);
      holds.push(dayIdx);
      pnlUsd += (pct / 100) * (num(t.size_usd) ?? 0);
    }

    rows.push({
      threshold: th,
      n,
      lockPct: n ? (locks / n) * 100 : 0,
      catastrophePct: n ? (catas / n) * 100 : 0,
      deadlinePct: n ? (deadlines / n) * 100 : 0,
      avgPct: avg(pcts),
      medPct: med(pcts),
      avgHoldDays: avg(holds),
      simulatedPnlUsd: pnlUsd,
    });
  }
  return { rows, calibration: { realizedUsd: closed.reduce((s, t) => s + (num(t.pnl_usd) ?? 0), 0) } };
}

/**
 * Second contrôle du balayage : SOUS CONTRAINTE DE CAPITAL.
 *
 * Monter le seuil allonge la détention (0.3j → 1.9j au 06/08). Le régulateur
 * plafonne à 100% depuis le 24/07 : au-delà d'un certain seuil, on ne peut plus
 * prendre tous les trades. Le balayage « libre » ignore ce coût — il faut donc
 * toujours l'accompagner de ce replay, qui rejoue les entrées dans l'ordre
 * chronologique avec un cap dur et compte les trades SKIPPÉS faute de capital.
 * Au 06/08 : 0 skip jusqu'à 2.5%, 9 à 3%, 40 à 4% → le capital ne mord pas dans
 * la bande retenue.
 */
export async function lockSweepCapitalConstrained(
  trades: Trade[],
  capitalUsd: number,
  thresholds = [1.5, 2.0, 2.5, 3.0, 4.0],
): Promise<Array<{ threshold: number; taken: number; skipped: number; pnlUsd: number }>> {
  const closed = trades
    .filter((t) => t.status !== 'open' && num(t.entry_price))
    .sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1));
  for (const t of closed) await fetchBars(t.symbol);

  const out: Array<{ threshold: number; taken: number; skipped: number; pnlUsd: number }> = [];
  for (const th of thresholds) {
    let cash = capitalUsd, pnl = 0, taken = 0, skipped = 0;
    const open: Array<{ size: number; pnl: number; exitT: string }> = [];

    for (const t of closed) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].exitT <= t.opened_at) { cash += open[i].size; pnl += open[i].pnl; open.splice(i, 1); }
      }
      const size = num(t.size_usd) ?? 0;
      if (size > cash) { skipped++; continue; }

      const bars = barCache.get(t.symbol) ?? [];
      const entry = num(t.entry_price);
      if (!bars.length || !entry) continue;
      const window = bars.filter((b) => b.date >= t.opened_at.slice(0, 10)).slice(0, HOLD_DAYS + 1);
      if (window.length < 2) continue;

      let pct: number | null = null;
      let exitDate = window[window.length - 1].date;
      for (const d of window) {
        const hi = ((d.high - entry) / entry) * 100;
        const lo = ((d.low - entry) / entry) * 100;
        if (lo <= CATASTROPHE_PCT) { pct = CATASTROPHE_PCT; exitDate = d.date; break; }
        if (hi >= th) { pct = th; exitDate = d.date; break; }
      }
      if (pct == null) pct = ((window[window.length - 1].close - entry) / entry) * 100;

      cash -= size;
      taken++;
      open.push({ size, pnl: (pct / 100) * size, exitT: `${exitDate}T21:00` });
    }
    for (const p of open) pnl += p.pnl;
    out.push({ threshold: th, taken, skipped, pnlUsd: pnl });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTINE 3 — QUI FERME LES POSITIONS ?
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Classe chaque sortie par son AUTEUR RÉEL.
 *
 * 🔴 L'ERREUR À NE PLUS REFAIRE (check-in 06/08) — comparer des MOYENNES :
 * avant/après l'activation de la couche LLM de sortie, le réalisé US passait de
 * +0.64% à +1.64% (+1.00 pt, au-dessus du critère de +0.3 pt) → « la couche
 * vaut le coup ». FAUX : sur les 62 sorties d'après, Mistral en avait décidé
 * ZÉRO (92% de lock déterministe). L'écart venait de la COMPOSITION — la
 * fenêtre « avant » traînait 49 closes manuels, 30 sorties « autres » à −5.46%
 * et 9 deadlines à −23.09%.
 *
 * La question qui tranche n'est pas « l'écart dépasse-t-il le seuil ? » mais
 * « la chose que je crédite a-t-elle seulement AGI ? ». D'où cette routine.
 *
 * Appariement : `paper_trades` (périmètre oversold faisant autorité) ×
 * `lisa_positions.exit_reason`, par symbole + minute de fermeture. Au 06/08 :
 * 382/382 US et 260/260 EU appariés (100%). Un taux d'appariement bas invalide
 * toute lecture — le vérifier avant de conclure.
 *
 * ⚠️ `lisa_positions.source` vaut 'lisa' pour les positions oversold — NE PAS
 * filtrer sur `source='scanner_oversold'`, ça renvoie 0 ligne (piège vécu).
 */
export function classifyExitReason(reason: string | null | undefined): string {
  if (!reason) return 'inconnu';
  if (/pré-LLM/.test(reason)) return 'LOCK déterministe';
  if (/oversold_mistral_gain_pick/.test(reason)) return 'MISTRAL (décision LLM)';
  if (/hold_expired|closed_expired|deadline/i.test(reason)) return 'deadline J+10';
  if (/stop_catastrophe/i.test(reason)) return 'CATASTROPHE';
  if (/ORPHAN_CLOSE/.test(reason)) return 'orphan (marché fermé)';
  if (/^\[manual\]/.test(reason)) return 'manuel user';
  if (/Stop-loss/.test(reason)) return 'stop mécanique';
  if (/Take-profit/.test(reason)) return 'TP mécanique';
  if (/closed_choppy|closed_invalidated|closed_stop|closed_target/.test(reason)) return 'autre (gainers legacy)';
  return 'autre';
}

export async function classifyExits(
  sb: SupabaseClient,
  portfolioId: string,
  trades: Trade[],
): Promise<{ matchRate: number; byKind: Map<string, { n: number; pnls: number[] }> }> {
  const closed = trades.filter((t) => t.closed_at);
  const positions: Array<{ symbol: string; exit_timestamp: string | null; exit_reason: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from('lisa_positions')
      .select('symbol,exit_timestamp,exit_reason')
      .eq('portfolio_id', portfolioId)
      .not('exit_timestamp', 'is', null)
      .range(from, from + 999);
    positions.push(...((data ?? []) as typeof positions));
    if (!data || data.length < 1000) break;
  }

  const index = new Map(positions.map((p) => [`${p.symbol}|${(p.exit_timestamp ?? '').slice(0, 16)}`, p]));
  const byKind = new Map<string, { n: number; pnls: number[] }>();
  let matched = 0;

  for (const t of closed) {
    const hit = index.get(`${t.symbol}|${(t.closed_at ?? '').slice(0, 16)}`);
    if (hit) matched++;
    const kind = classifyExitReason(hit?.exit_reason);
    const slot = byKind.get(kind) ?? { n: 0, pnls: [] };
    slot.n++;
    const p = num(t.pnl_pct);
    if (p != null) slot.pnls.push(p);
    byKind.set(kind, slot);
  }
  return { matchRate: closed.length ? matched / closed.length : 0, byKind };
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTINE 4 — RECONSTRUCTION DE idx5d (couverture 100%)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Recalcule la performance 5 jours de l'indice de référence à la date d'entrée,
 * depuis les VRAIES barres — au lieu de lire `features_at_entry`.
 *
 * 🔴 POURQUOI — `features_at_entry.spy5d` n'existe que sur 253/384 entrées US
 * (66%), et les 131 manquantes ne sont PAS un simple préfixe temporel : elles
 * s'entrelacent avec les autres. Bucketiser sur 66% d'une population, c'est
 * mesurer un échantillon dont on ignore le biais de sélection. En reconstruisant
 * depuis SPY.US / SX5E.INDX on passe à 100%, et le verdict CHANGE :
 *   · sur 66%  : le gate euphorie à 1.5% écarte du P&L POSITIF (+$1 882)
 *   · sur 100% : il écarte −$1 868… mais tout tient à UNE journée (01/07, 26
 *     entrées semi-conducteurs, −$12 399). Retirer la pire perte → +$1 760.
 *
 * ⚠️ La leçon générale, valable pour TOUT filtre de régime : le bucket
 * +1.5..+2.5% est catastrophique sur `fwd_return_10d` (−8.09%, 46% de
 * catastrophes) et NEUTRE sur le réalisé (−0.02%) — parce qu'on n'détient pas
 * jusqu'à J+10, on encaisse au lock. Un filtre calibré sur fwdJ+10 filtre une
 * stratégie qu'on ne joue pas. TOUJOURS re-tester sur le réalisé.
 */
export const INDEX_SYMBOL: Record<string, string> = { [US]: 'SPY.US', [EU]: 'SX5E.INDX' };

export async function rebuildIndex5d(
  trades: Trade[],
  indexSymbol: string,
): Promise<Array<Trade & { idx5d: number }>> {
  const series = await fetchBars(indexSymbol);
  if (!series.length) throw new Error(`série ${indexSymbol} indisponible`);

  const at = (dateIso: string): number | null => {
    let i = -1;
    for (let k = 0; k < series.length; k++) {
      if (series[k].date < dateIso) i = k;   // dernier close STRICTEMENT avant l'entrée
      else break;
    }
    return i < 5 ? null : ((series[i].close - series[i - 5].close) / series[i - 5].close) * 100;
  };

  const out: Array<Trade & { idx5d: number }> = [];
  for (const t of trades) {
    const v = at(t.opened_at.slice(0, 10));
    if (v != null) out.push({ ...t, idx5d: v });
  }
  return out;
}

/**
 * Test de sensibilité aux valeurs extrêmes — le garde-fou qui a démasqué le
 * gate euphorie. Un filtre dont le bénéfice disparaît quand on retire 1 ou 2
 * trades n'est pas une loi de régime : c'est un épisode. Le remède est alors un
 * cap de concentration (secteur / corrélation), pas un filtre de marché.
 */
export function sensitivityToWorst(
  rows: Array<{ pnl_usd: string | null; pnl_pct: string | null }>,
  ks = [0, 1, 2, 3, 5],
): Array<{ k: number; n: number; pnlUsd: number; avgPct: number | null; medPct: number | null }> {
  const sorted = [...rows].sort((a, b) => (num(a.pnl_usd) ?? 0) - (num(b.pnl_usd) ?? 0));
  return ks.map((k) => {
    const rest = sorted.slice(k);
    const pcts = rest.map((r) => num(r.pnl_pct)).filter((v): v is number => v != null);
    return {
      k,
      n: rest.length,
      pnlUsd: rest.reduce((s, r) => s + (num(r.pnl_usd) ?? 0), 0),
      avgPct: avg(pcts),
      medPct: med(pcts),
    };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// CLI
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const run = (name: string) => want.length === 0 || want.includes(name);
  const sb = client();

  const data = new Map<string, Trade[]>();
  for (const [label, id] of PORTFOLIOS) {
    data.set(label, await allTrades(sb, id));
    console.log(`${label} : ${data.get(label)!.length} trades oversold chargés`);
  }

  if (run('exposure')) {
    console.log('\n═══ 1. EXPOSITION (replay chronologique) ═══');
    for (const [label, id] of PORTFOLIOS) {
      const days = exposureReplay(data.get(label)!, CAPITAL[id]);
      const before = days.filter((d) => d.day < '2026-07-24');
      const after = days.filter((d) => d.day >= '2026-07-24');
      const show = (tag: string, a: typeof days) =>
        a.length &&
        console.log(
          `  ${label} ${tag} : pic moy ${avg(a.map((x) => x.peakPct))!.toFixed(0)}%  ` +
            `pic méd ${med(a.map((x) => x.peakPct))!.toFixed(0)}%  ` +
            `PIC MAX ${Math.max(...a.map((x) => x.peakPct)).toFixed(1)}%  ` +
            `jours > 100% : ${a.filter((x) => x.peakPct > 100).length}/${a.length}`,
        );
      show('avant régulateur (< 24/07)', before);
      show('après régulateur (≥ 24/07)', after);
    }
  }

  if (run('lock')) {
    console.log('\n═══ 2. BALAYAGE DU LOCK (stop catastrophe appliqué) ═══');
    for (const [label, id] of PORTFOLIOS) {
      const { rows, calibration } = await lockSweep(data.get(label)!);
      const base = rows.find((r) => r.threshold === 1.5)!;
      console.log(`\n  ${label} — n=${base.n}`);
      console.log('  seuil  | %lock | %cata | %dead | /trade |  méd   | jours | P&L sim $ | Δ vs 1.5%');
      for (const r of rows) {
        console.log(
          `  ${String(r.threshold).padStart(5)}% |  ${r.lockPct.toFixed(0).padStart(3)}% |  ` +
            `${r.catastrophePct.toFixed(0).padStart(3)}% |  ${r.deadlinePct.toFixed(0).padStart(3)}% | ` +
            `${fmt(r.avgPct).padStart(6)}% | ${fmt(r.medPct).padStart(6)}% | ` +
            `${r.avgHoldDays!.toFixed(1).padStart(5)} | ${fmt(r.simulatedPnlUsd, 0).padStart(9)} | ` +
            `${fmt(r.simulatedPnlUsd - base.simulatedPnlUsd, 0).padStart(8)}`,
        );
      }
      const err = base.simulatedPnlUsd - calibration.realizedUsd;
      console.log(
        `  ⚠️ CALIBRATION : simulé au seuil actuel ${fmt(base.simulatedPnlUsd, 0)} vs réel encaissé ` +
          `${fmt(calibration.realizedUsd, 0)} → erreur ${fmt(err, 0)}` +
          `${Math.abs(err) > Math.abs(calibration.realizedUsd) * 0.15 ? ' — ÉCART > 15%, ne lire QUE le classement' : ' — modèle fiable'}`,
      );
      const cap = await lockSweepCapitalConstrained(data.get(label)!, CAPITAL[id]);
      console.log(`  sous contrainte de capital : ${cap.map((c) => `${c.threshold}%→${c.skipped} skip`).join(', ')}`);
    }
  }

  if (run('exits')) {
    console.log('\n═══ 3. QUI FERME LES POSITIONS ? ═══');
    for (const [label, id] of PORTFOLIOS) {
      const { matchRate, byKind } = await classifyExits(sb, id, data.get(label)!);
      console.log(`\n  ${label} — appariement ${(matchRate * 100).toFixed(0)}%${matchRate < 0.9 ? ' ⚠️ TROP BAS, lecture invalide' : ''}`);
      for (const [kind, v] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`     ${kind.padEnd(24)} ${String(v.n).padStart(3)}  /trade ${fmt(avg(v.pnls))}%`);
      }
    }
  }

  if (run('idx5d')) {
    console.log('\n═══ 4. BUCKETS DE RÉGIME (idx5d reconstruit, couverture 100%) ═══');
    for (const [label, id] of PORTFOLIOS) {
      const rows = await rebuildIndex5d(data.get(label)!, INDEX_SYMBOL[id]);
      console.log(`\n  ${label} — ${rows.length}/${data.get(label)!.length} enrichis (${INDEX_SYMBOL[id]})`);
      console.log('  idx5d bucket  |  n  | fwdJ+10 | catas | RÉALISÉ | WR réal |  P&L $');
      for (const [lo, hi] of [[-99, -1.5], [-1.5, 0], [0, 1.5], [1.5, 2.5], [2.5, 99]]) {
        const b = rows.filter((r) => r.idx5d >= lo && r.idx5d < hi);
        const lab = b.map((r) => num(r.fwd_return_10d)).filter((v): v is number => v != null);
        const cl = b.filter((r) => r.status !== 'open' && num(r.pnl_pct) != null);
        const cp = cl.map((r) => num(r.pnl_pct)!).filter(Number.isFinite);
        const cata = lab.length ? (lab.filter((x) => x < -10).length / lab.length) * 100 : null;
        console.log(
          `  ${String(lo === -99 ? '-inf' : lo).padStart(5)} .. ${String(hi === 99 ? '+inf' : hi).padStart(4)} | ` +
            `${String(b.length).padStart(3)} | ${fmt(avg(lab)).padStart(6)}% | ${fmt(cata, 0).padStart(4)}% | ` +
            `${fmt(avg(cp)).padStart(6)}% | ${fmt(winRate(cp), 0).padStart(5)}% | ` +
            `${fmt(cl.reduce((s, r) => s + (num(r.pnl_usd) ?? 0), 0), 0).padStart(7)}`,
        );
      }
      const excluded = rows.filter((r) => r.idx5d > 1.5 && r.status !== 'open' && num(r.pnl_pct) != null);
      console.log(`  sensibilité aux extrêmes sur ce que le gate à 1.5% écarterait (n=${excluded.length}) :`);
      for (const s of sensitivityToWorst(excluded)) {
        console.log(`     sans les ${s.k} pires : n=${s.n}  P&L ${fmt(s.pnlUsd, 0).padStart(7)}  méd ${fmt(s.medPct)}%`);
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ÉCHEC :', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
