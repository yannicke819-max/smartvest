'use client';

import { useEffect, useRef, useState } from 'react';
import { Rocket, TrendingUp, TrendingDown, Settings2, Calendar, CalendarDays, CalendarRange, Activity } from 'lucide-react';
import {
  useGainersStatus,
  useGainersConfig,
  useUpdateGainersConfig,
  useOperatingMode,
  usePersistenceSnapshot,
  useUpdateGainersCycle,
  useEodhdQuota,
  type CoverageSource,
  type PathQualityByTf,
  type PersistenceCandidate,
  type GainersStatus,
} from '@/hooks/use-operating-mode';

/**
 * P19y (29/04/2026) — Inférence cause cellule "—" pour badge UI.
 *
 * Quand `coverage='none'` ou tf1m=null, on infère la cause :
 *   - market_closed : ticker asia/EU dont session est fermée (heure UTC actuelle)
 *   - illiquid_1m   : ticker US sans 1m fetched (microcaps sparse)
 *   - unsupported   : ticker dont aucun provider ne couvre
 *
 * Sessions UTC :
 *   KOSPI / KOSDAQ : 00:00–06:30 UTC Mon-Fri (.KO/.KQ/.KS/.KE)
 *   NSE / BSE      : 03:45–10:00 UTC Mon-Fri
 *   ASX            : 23:00–05:00 UTC (overnight)
 *   Tokyo          : 00:00–06:00 UTC Mon-Fri (.T)
 *   HK             : 01:30–08:00 UTC Mon-Fri (.HK)
 *   LSE/XETRA/PA   : 08:00–16:30 UTC Mon-Fri
 *   NYSE/NASDAQ    : 14:30–21:00 UTC Mon-Fri (+ premarket 09:00)
 */
function inferCoverageCause(
  symbol: string,
  market: string,
  coverage: CoverageSource | undefined,
  tf1mValue: number | null,
): { kind: 'ok' | 'closed' | 'illiquid' | 'unsupported' | 'cache_stale' | 'degraded'; tooltip: string } {
  // Si on a une vraie data (eodhd_1m/yahoo/binance), pas de badge cause
  if (tf1mValue != null && coverage && coverage !== 'none') {
    return { kind: 'ok', tooltip: `coverage=${coverage}` };
  }
  if (coverage === 'cache_stale') {
    return { kind: 'cache_stale', tooltip: 'Cache stale (provider down) — donnée < 15 min' };
  }
  if (coverage === 'eodhd' || coverage === 'eodhd_ticks') {
    return {
      kind: 'degraded',
      tooltip: coverage === 'eodhd_ticks'
        ? '5m bars reconstruits depuis ticks — tf1m non dispo'
        : '5m only (résolution insuffisante pour tf1m)',
    };
  }

  // coverage='none' ou tf1m null → infère cause
  const upper = (market || '').toUpperCase();
  const sym = (symbol || '').toUpperCase();
  const ASIA_MARKETS = ['KO', 'KQ', 'KS', 'KE', 'NSE', 'BSE', 'AU', 'AX', 'T', 'TSE', 'HK', 'SS', 'SZ'];
  const EU_MARKETS = ['LSE', 'XETRA', 'L', 'DE', 'PA', 'AS', 'AMS', 'MI', 'SW', 'MC', 'BME'];
  const isAsia = ASIA_MARKETS.includes(upper) || /\.(KO|KQ|KS|KE|NSE|BSE|AU|AX|T|HK|SS|SZ)$/.test(sym);
  const isEu = EU_MARKETS.includes(upper) || /\.(LSE|L|XETRA|DE|PA|AS|AMS|MI|SW|MC|BME)$/.test(sym);
  const isUs = upper === 'US' || /\.US$/.test(sym);

  const utcHour = new Date().getUTCHours();
  const utcDay = new Date().getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = utcDay === 0 || utcDay === 6;

  if (isAsia) {
    // KOSPI/KOSDAQ/Tokyo session 00:00–06:30 UTC ; NSE 03:45–10:00 ; HK 01:30–08:00
    const inAsiaSession = !isWeekend && utcHour < 10;
    if (!inAsiaSession) {
      return { kind: 'closed', tooltip: 'Marché asiatique fermé — réouvre 00:00–10:00 UTC Mon-Fri' };
    }
  }
  if (isEu) {
    const inEuSession = !isWeekend && utcHour >= 7 && utcHour < 17;
    if (!inEuSession) {
      return { kind: 'closed', tooltip: 'Marché européen fermé — ouvre 08:00–16:30 UTC Mon-Fri' };
    }
  }
  if (isUs) {
    // US 14:30–21:00 UTC + premarket 09:00 + after-hours jusqu'à 24:00
    const inUsExt = !isWeekend && utcHour >= 9 && utcHour < 24;
    if (inUsExt) {
      // Marché ouvert mais 1m manquant → likely illiquid microcap
      return { kind: 'illiquid', tooltip: 'Marché US ouvert mais 1m absent — microcap illiquide (trades sparses)' };
    }
    return { kind: 'closed', tooltip: 'Marché US fermé — ouvre 14:30–21:00 UTC Mon-Fri' };
  }

  return { kind: 'unsupported', tooltip: 'Aucun provider ne couvre ce ticker' };
}

function CoverageBadge({ cause }: { cause: ReturnType<typeof inferCoverageCause> }) {
  if (cause.kind === 'ok') return null;
  const cfg: Record<string, { emoji: string; bg: string }> = {
    closed: { emoji: '🌙', bg: 'bg-slate-200 dark:bg-slate-700' },
    illiquid: { emoji: '💧', bg: 'bg-amber-100 dark:bg-amber-900/40' },
    unsupported: { emoji: '⚠️', bg: 'bg-red-100 dark:bg-red-900/40' },
    cache_stale: { emoji: '🟠', bg: 'bg-orange-100 dark:bg-orange-900/40' },
    degraded: { emoji: '🟡', bg: 'bg-yellow-100 dark:bg-yellow-900/40' },
  };
  const c = cfg[cause.kind] ?? cfg.unsupported;
  return (
    <span
      className={`inline-flex items-center justify-center text-[9px] px-1 rounded ${c.bg} ml-1`}
      title={cause.tooltip}
      aria-label={cause.tooltip}
    >
      {c.emoji}
    </span>
  );
}

const CYCLE_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];

/**
 * P7-MODE-GAINERS-BADGE — Mini-tile sous le badge GAINERS actif.
 * P9-UX : selector de cycle + slider topN dynamique + path quality badge.
 *
 * Affiche en temps réel (poll 30s) :
 *   - Selector "Fréquence scan" (1, 2, 3, 5, 10, 15, 20, 30, 45, 60 min) → DB write
 *   - Countdown vers prochain scan (mm:ss) basé sur cycle DB
 *   - Positions ouvertes / max
 *   - PnL session UTC (vert si >0, rouge si <0)
 *   - 3 derniers candidats vus (top score du dernier tick)
 *
 * Rendu uniquement quand strategy_mode='gainers'. Auto-masqué sinon.
 */
export function GainersStatusTile({ portfolioId }: { portfolioId: string }) {
  const modeQuery = useOperatingMode(portfolioId);
  const isGainersMode = modeQuery.data?.mode === 'gainers';
  const statusQuery = useGainersStatus(portfolioId, isGainersMode);

  // Client-side countdown that ticks every second between backend polls (30s).
  // Without this the displayed value freezes for 30s then jumps on each refetch.
  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (statusQuery.data?.nextTickInSeconds != null) {
      setCountdown(statusQuery.data.nextTickInSeconds);
    }
  }, [statusQuery.data?.nextTickInSeconds]);
  useEffect(() => {
    const id = setInterval(() => setCountdown((s) => Math.max(0, s - 1)), 1_000);
    return () => clearInterval(id);
  }, []);

  if (!isGainersMode) return null;

  const data = statusQuery.data;

  return (
    <div className="rounded-lg border border-orange-200 dark:border-orange-900/40 bg-orange-50/40 dark:bg-orange-950/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Rocket className="h-4 w-4 text-orange-600" />
        <h3 className="text-sm font-medium">Scanner Gainers · état temps réel</h3>
      </div>

      {!data && (
        <p className="text-xs text-muted-foreground">Chargement…</p>
      )}

      {data && (
        <>
          {/* PR #243 — Bandeau trajectory status (visible uniquement si adaptive_enabled) */}
          {data.adaptiveEnabled && (
            <TrajectoryBandeau status={data} />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Bloc gauche — countdown + 2 metrics existantes */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Prochain scan
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {formatCountdown(countdown)}
                </p>
                <CycleSelector
                  portfolioId={portfolioId}
                  currentCycle={data.intervalMinutes}
                />
              </div>
              <Stat
                label="Positions ouvertes"
                value={String(data.openPositions)}
              />
              <Stat
                label="PnL session"
                value={formatPnl(data.sessionPnlUsd)}
                valueClass={
                  data.sessionPnlUsd > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : data.sessionPnlUsd < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-muted-foreground'
                }
                hint="Réalisé · UTC"
              />
            </div>

            {/* Bloc droit — compteurs jour (Option B) avec sparkline + breakdown */}
            <DailyCountersPanel data={data} countdown={countdown} />
          </div>

          {/* PR #246 — Cartes Gains du jour / Gains du mois (mode-agnostique).
              Source : paper_trades closed strategy='top_gainers_v1'. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <DailyGainsCard data={data} />
            <MonthlyGainsCard data={data} />
            <YearlyGainsCard data={data} />
          </div>

          {/* PR #258 — Indicateur quota EODHD (auto-pause à 85% / 95%) */}
          <EodhdQuotaIndicator />

          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Derniers candidats scannés
            </p>
            {data.lastCandidates.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Aucun scan terminé pour l&apos;instant. Le premier cycle s&apos;exécute dans quelques minutes.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {data.lastCandidates.map((c) => {
                  const positive = c.changePct >= 0;
                  const Icon = positive ? TrendingUp : TrendingDown;
                  return (
                    <li
                      key={c.symbol}
                      className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
                    >
                      <Icon
                        className={`h-3 w-3 ${
                          positive ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      />
                      <span className="font-medium">{c.symbol}</span>
                      <span
                        className={positive ? 'text-emerald-600' : 'text-red-600'}
                      >
                        {positive ? '+' : ''}
                        {c.changePct.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground">
                        ·&nbsp;score {c.score.toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {/* P19x.2 fix — Paramètres scanner : TP/SL/persistence */}
      <GainersConfigForm portfolioId={portfolioId} />

      {/* P8 + P9-UX — Multi-TF persistence snapshot */}
      <PersistencePanel portfolioId={portfolioId} />
    </div>
  );
}

/**
 * P19x.2 fix — Formulaire paramètres scanner Gainers.
 *
 * Champs : gainers_default_tp_pct (0.1-50), gainers_default_sl_pct (0.1-20),
 * gainers_min_persistence_score (0-1 ou null = global default 0.67).
 *
 * Lecture : GET /lisa/config/:portfolioId
 * Écriture : POST /lisa/config/:portfolioId (body partiel — champs modifiés uniquement)
 *
 * Validation front alignée sur le backend :
 *   TP : [0.1, 50]%, SL : [0.1, 20]%, persistence : [0, 1] ou vide (null)
 *
 * RR = TP/SL affiché live pendant la saisie.
 * Feedback inline : success (vert 3s) / error (rouge persistant).
 */
function GainersConfigForm({ portfolioId }: { portfolioId: string }) {
  const configQuery = useGainersConfig(portfolioId);
  const mut = useUpdateGainersConfig(portfolioId);

  const [open, setOpen] = useState(false);

  // Form state — seeded from DB, updated locally
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [ps, setPs] = useState(''); // '' = null (use global default)

  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Seed form when DB data arrives (only when panel is opened for the first time)
  useEffect(() => {
    if (!open || !configQuery.data) return;
    setTp(configQuery.data.gainers_default_tp_pct != null
      ? String(configQuery.data.gainers_default_tp_pct)
      : '1.5');
    setSl(configQuery.data.gainers_default_sl_pct != null
      ? String(configQuery.data.gainers_default_sl_pct)
      : '1.0');
    setPs(configQuery.data.gainers_min_persistence_score != null
      ? String(configQuery.data.gainers_min_persistence_score)
      : '');
  }, [open, configQuery.dataUpdatedAt]);

  const tpNum = parseFloat(tp);
  const slNum = parseFloat(sl);
  const psNum = ps === '' ? null : parseFloat(ps);

  const tpErr =
    !tp || isNaN(tpNum) || tpNum < 0.1 || tpNum > 50
      ? 'TP : 0.1 – 50 %'
      : null;
  const slErr =
    !sl || isNaN(slNum) || slNum < 0.1 || slNum > 20
      ? 'SL : 0.1 – 20 %'
      : null;
  const psErr =
    ps !== '' && (isNaN(psNum!) || psNum! < 0 || psNum! > 1)
      ? 'Score : 0 – 1 (ou vide = défaut 0.67)'
      : null;

  const rr = !tpErr && !slErr && slNum > 0 ? (tpNum / slNum).toFixed(2) : '—';
  const canSave = !tpErr && !slErr && !psErr && !mut.isPending;

  const handleSave = () => {
    if (!canSave) return;
    setFeedback(null);
    mut.mutate(
      {
        gainers_default_tp_pct: tpNum,
        gainers_default_sl_pct: slNum,
        gainers_min_persistence_score: psNum,
      },
      {
        onSuccess: () => {
          setFeedback({ kind: 'ok', msg: 'Sauvegardé ✓' });
          setTimeout(() => setFeedback(null), 3000);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Erreur serveur';
          setFeedback({ kind: 'err', msg });
        },
      },
    );
  };

  return (
    <div className="rounded-md border bg-background/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
          <Settings2 className="h-3 w-3" />
          Paramètres scanner
        </span>
        <span className="text-[10px]">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t">
          {configQuery.isLoading && (
            <p className="text-xs text-muted-foreground pt-2">Chargement…</p>
          )}

          {!configQuery.isLoading && (
            <>
              <div className="grid grid-cols-2 gap-3 pt-2">
                {/* TP */}
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-medium">
                    Take-profit (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="50"
                    value={tp}
                    onChange={(e) => setTp(e.target.value)}
                    className="h-7 w-full rounded border bg-background px-2 text-xs"
                    placeholder="1.5"
                  />
                  {tpErr && <p className="text-[10px] text-red-600">{tpErr}</p>}
                </div>

                {/* SL */}
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-medium">
                    Stop-loss (%)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="20"
                    value={sl}
                    onChange={(e) => setSl(e.target.value)}
                    className="h-7 w-full rounded border bg-background px-2 text-xs"
                    placeholder="1.0"
                  />
                  {slErr && <p className="text-[10px] text-red-600">{slErr}</p>}
                </div>
              </div>

              {/* R/R computed */}
              <p className="text-[10px] text-muted-foreground">
                R/R calculé : <span className="font-medium tabular-nums">{rr}</span>
                {rr !== '—' && Number(rr) < 1 && (
                  <span className="text-amber-600"> ⚠ R/R &lt; 1 — risque supérieur au gain potentiel</span>
                )}
              </p>

              {/* Min persistence score */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground font-medium">
                  Score persistence min (0 – 1, vide = défaut 0.67)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={ps}
                  onChange={(e) => setPs(e.target.value)}
                  className="h-7 w-32 rounded border bg-background px-2 text-xs"
                  placeholder="0.67"
                />
                {psErr && <p className="text-[10px] text-red-600">{psErr}</p>}
                <p className="text-[10px] text-muted-foreground/70">
                  Fraction de TFs positifs requis. Ex : 0.67 = 4/6 TFs en hausse.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!canSave}
                  className="h-7 rounded bg-orange-600 px-3 text-xs font-medium text-white disabled:opacity-40 hover:bg-orange-700 transition-colors"
                >
                  {mut.isPending ? 'Sauvegarde…' : 'Sauvegarder'}
                </button>
                {feedback && (
                  <p
                    className={`text-[11px] font-medium ${
                      feedback.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {feedback.msg}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * P9-UX — Selector "Fréquence scan" (replace "Cycle X min" hardcoded).
 * 10 valeurs préconfigurées : 1, 2, 3, 5, 10, 15, 20, 30, 45, 60. POST DB
 * lisa_session_configs.gainers_cycle_minutes via useUpdateGainersCycle.
 *
 * Toast d'avertissement si user choisit 1 min (coût API ×15 vs 15 min).
 */
function CycleSelector({
  portfolioId,
  currentCycle,
}: {
  portfolioId: string;
  currentCycle: number;
}) {
  const mut = useUpdateGainersCycle(portfolioId);
  // Optimistic local state: keeps the user's selection visible while the
  // mutation round-trips. Without this, the controlled <select> snaps back
  // to currentCycle (stale server value) every 30 s poll or during the
  // ~500 ms before the invalidated query refetches.
  const [localCycle, setLocalCycle] = useState(currentCycle);
  const [warn, setWarn] = useState<string | null>(null);
  const pendingRef = useRef(false);

  // Sync from server only when no mutation is in flight (avoids overwriting
  // the optimistic value before the server acknowledges the change).
  useEffect(() => {
    if (!pendingRef.current) {
      setLocalCycle(currentCycle);
    }
  }, [currentCycle]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = parseInt(e.target.value, 10);
    if (!Number.isFinite(next)) return;
    setLocalCycle(next);
    pendingRef.current = true;
    if (next === 1) {
      setWarn('Coût API ×15 vs 15 min — surveille daily_cost_budget_usd');
    } else if (next < 5) {
      setWarn('Cycle < 5 min — risque rate-limit EODHD/Binance');
    } else {
      setWarn(null);
    }
    mut.mutate(next, {
      onSettled: () => {
        pendingRef.current = false;
      },
    });
  };

  return (
    <div className="space-y-0.5">
      <label className="text-[10px] text-muted-foreground flex items-center gap-1">
        <span>Fréquence scan</span>
        {mut.isPending && <span className="text-orange-600">…</span>}
      </label>
      <select
        value={localCycle}
        onChange={handleChange}
        disabled={mut.isPending}
        className="h-6 rounded border bg-background px-1.5 text-xs"
        aria-label="Fréquence du scanner Gainers"
      >
        {CYCLE_OPTIONS.map((min) => (
          <option key={min} value={min}>{min} min</option>
        ))}
      </select>
      {warn && (
        <p className="text-[10px] text-amber-700 dark:text-amber-500">⚠ {warn}</p>
      )}
    </div>
  );
}

/**
 * P8 + P9-UX — Slider topN + summary counters par TF + path quality badge.
 *
 * P9-UX changements :
 * - Titre "Top {N} candidats" interpolé (au lieu de "Top 10" hardcoded)
 * - Slice tableau à N lignes
 * - Summary counters use N comme denominator
 * - Sous-titre "Top {N} en hausse 1min"
 * - Debounce slider 300ms avant refetch
 * - Colonne Path avec badge 🟢/🟡/🔴
 * - Toggle "Cacher choppy" filtre client-side
 */
function PersistencePanel({ portfolioId }: { portfolioId: string }) {
  const [topN, setTopN] = useState(20);
  const [debouncedTopN, setDebouncedTopN] = useState(20);
  const [hideChoppy, setHideChoppy] = useState(false);

  // P9-UX — Debounce 300ms : évite spam backend lors du drag du slider.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTopN(topN), 300);
    return () => clearTimeout(id);
  }, [topN]);

  const snapQuery = usePersistenceSnapshot(portfolioId, debouncedTopN, true);
  const data = snapQuery.data;

  // Filtre client-side choppy
  const visibleCandidates: PersistenceCandidate[] = data
    ? hideChoppy
      ? data.candidates.filter(
          (c) => c.pathQuality?.overallSmoothness !== 'choppy',
        )
      : data.candidates
    : [];
  // Slice à topN (le backend peut retourner moins si données insuffisantes)
  const sliced = visibleCandidates.slice(0, topN);

  // Summary recalculé sur sliced pour cohérence avec ce qu'on affiche
  const recomputedSummary = data
    ? {
        oneMinute: sliced.filter((c) => (c.tf1m ?? 0) > 0).length,
        fiveMinutes: sliced.filter((c) => (c.tf5m ?? 0) > 0).length,
        tenMinutes: sliced.filter((c) => (c.tf10m ?? 0) > 0).length,
        fifteenMinutes: sliced.filter((c) => (c.tf15m ?? 0) > 0).length,
        thirtyMinutes: sliced.filter((c) => (c.tf30m ?? 0) > 0).length,
        oneHour: sliced.filter((c) => (c.tf1h ?? 0) > 0).length,
      }
    : null;

  return (
    <div className="rounded-md border bg-background/60 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Persistance multi-TF
          </p>
          <p className="text-[11px] text-muted-foreground italic">
            Top {topN} en hausse 1min · combien sont aussi en hausse 5m/10m/15m/30m/1h ?
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[11px] text-muted-foreground">N=</label>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={topN}
            onChange={(e) => setTopN(parseInt(e.target.value, 10))}
            className="w-32"
            aria-label="Nombre de valeurs scannées"
            list="topN-ticks"
          />
          <datalist id="topN-ticks">
            {[5, 10, 20, 50, 100].map((tick) => (
              <option key={tick} value={tick} />
            ))}
          </datalist>
          <span className="text-xs font-medium tabular-nums w-8 text-right">{topN}</span>
          <label className="flex items-center gap-1 text-[11px] cursor-pointer">
            <input
              type="checkbox"
              checked={hideChoppy}
              onChange={(e) => setHideChoppy(e.target.checked)}
              className="h-3 w-3"
            />
            <span>Cacher choppy</span>
          </label>
        </div>
      </div>

      {snapQuery.isLoading && (
        <p className="text-xs text-muted-foreground">Calcul en cours…</p>
      )}

      {data && recomputedSummary && (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {(
              [
                ['1m', recomputedSummary.oneMinute],
                ['5m', recomputedSummary.fiveMinutes],
                ['10m', recomputedSummary.tenMinutes],
                ['15m', recomputedSummary.fifteenMinutes],
                ['30m', recomputedSummary.thirtyMinutes],
                ['1h', recomputedSummary.oneHour],
              ] as Array<[string, number]>
            ).map(([label, count]) => (
              <SummaryCell
                key={label}
                label={label}
                count={count}
                total={topN}
              />
            ))}
          </div>

          {sliced.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                Top {topN} candidats {sliced.length < topN ? `(${sliced.length} dispos)` : ''}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left pr-2 font-medium">Symbol</th>
                      <th className="text-right px-1 font-medium">1m</th>
                      <th className="text-right px-1 font-medium">5m</th>
                      <th className="text-right px-1 font-medium">10m</th>
                      <th className="text-right px-1 font-medium">15m</th>
                      <th className="text-right px-1 font-medium">30m</th>
                      <th className="text-right px-1 font-medium">1h</th>
                      <th
                        className="text-right pl-1 font-medium cursor-help"
                        title="Persistence count : nombre de TFs avec change>0 / TFs disponibles. Ex: 6/6 = positif sur tous les 6 TFs (1m,5m,10m,15m,30m,1h)."
                      >
                        Score
                      </th>
                      <th
                        className="text-right pl-1 font-medium cursor-help"
                        title="Path quality : 🟢 smooth / 🟡 mixed / 🔴 choppy. Cf légende sous le tableau."
                      >
                        Path
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sliced.map((c) => {
                      const cause = inferCoverageCause(c.symbol, c.market, c.coverage, c.tf1m);
                      return (
                      <tr key={c.symbol} className="border-t">
                        <td className="text-left pr-2 font-medium py-0.5">
                          <span>{c.symbol}</span>
                          <CoverageBadge cause={cause} />
                        </td>
                        <Cell value={c.tf1m} />
                        <Cell value={c.tf5m} />
                        <Cell value={c.tf10m} />
                        <Cell value={c.tf15m} />
                        <Cell value={c.tf30m} />
                        <Cell value={c.tf1h} />
                        <td className="text-right pl-1 py-0.5">
                          {c.persistenceCount ?? '—'}
                        </td>
                        <td className="text-right pl-1 py-0.5">
                          <PathBadge pq={c.pathQuality ?? null} />
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <PathLegend />
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            Snapshot {new Date(data.capturedAt).toLocaleTimeString()} · refresh 60s · debounce slider 300ms
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCell({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const pct = total > 0 ? count / total : 0;
  return (
    <div className="rounded-md border bg-background p-2 text-center space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`text-base font-semibold tabular-nums ${
          pct >= 0.7
            ? 'text-emerald-600'
            : pct >= 0.4
              ? 'text-amber-600'
              : 'text-muted-foreground'
        }`}
      >
        {count}
        <span className="text-[10px] text-muted-foreground"> /{total}</span>
      </p>
    </div>
  );
}

function Cell({ value }: { value: number | null }) {
  if (value == null) {
    return (
      <td className="text-right px-1 text-muted-foreground/50 py-0.5">—</td>
    );
  }
  const positive = value > 0;
  return (
    <td
      className={`text-right px-1 py-0.5 ${
        positive ? 'text-emerald-600' : value < 0 ? 'text-red-600' : 'text-muted-foreground'
      }`}
    >
      {positive ? '+' : ''}
      {value.toFixed(1)}
    </td>
  );
}

/**
 * P9-UX ADDENDUM + P19x.9 (29/04/2026) — Path quality badge avec tooltip enrichi.
 * 🟢 smooth (efficiency≥0.7 + pullback≤1%)  : path valide → candidat éligible
 * 🟡 mixed (entre les deux)                 : path partiel → certains TFs OK
 * 🔴 choppy (efficiency<0.4 OU pullback>2%) : path bloqué → pump-and-dump rejeté
 */
function PathBadge({ pq }: { pq: PathQualityByTf | null }) {
  if (!pq || !pq.overallSmoothness) {
    return (
      <span title="Aucune donnée de path quality (pas assez de candles)" className="text-muted-foreground/50 cursor-help">
        —
      </span>
    );
  }
  if (pq.overallSmoothness === 'idle') {
    return (
      <span title="Données figées (marché fermé ou prix constant) — path quality non évaluable" className="cursor-help opacity-40">
        ⚪
      </span>
    );
  }
  const emoji =
    pq.overallSmoothness === 'smooth' ? '🟢'
    : pq.overallSmoothness === 'mixed' ? '🟡'
    : '🔴';
  // P19x.9 — Tooltip explicit selon kind
  const labelByKind = {
    smooth: 'Path valide — candidat éligible (eff≥70%, pullback≤1%)',
    mixed:  'Path partiel — certains TFs alignés, autres bruyants',
    choppy: 'Path bloqué — choppy (eff<40% OU pullback>2%) → pump-and-dump probable, rejeté par gate',
  } as const;
  const baseLabel = labelByKind[pq.overallSmoothness] ?? pq.overallSmoothness;
  const effPart = pq.overallEfficiency != null
    ? `\nEfficiency: ${(pq.overallEfficiency * 100).toFixed(0)}%`
    : '';
  const tfBreakdown = [
    pq.tf5m && `5m:${pq.tf5m.smoothnessLabel}`,
    pq.tf10m && `10m:${pq.tf10m.smoothnessLabel}`,
    pq.tf15m && `15m:${pq.tf15m.smoothnessLabel}`,
    pq.tf30m && `30m:${pq.tf30m.smoothnessLabel}`,
    pq.tf1h && `1h:${pq.tf1h.smoothnessLabel}`,
  ].filter(Boolean).join(' · ');
  const tfPart = tfBreakdown ? `\nPer TF: ${tfBreakdown}` : '';
  const tooltip = `${baseLabel}${effPart}${tfPart}`;
  return (
    <span title={tooltip} className="cursor-help">
      {emoji}
    </span>
  );
}

function Stat(props: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
        {props.label}
      </p>
      <p className={`text-lg font-semibold tabular-nums ${props.valueClass ?? ''}`}>
        {props.value}
      </p>
      {props.hint && <p className="text-[10px] text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec.toString().padStart(2, '0')}s`;
}

function formatPnl(usd: number): string {
  const sign = usd > 0 ? '+' : usd < 0 ? '−' : '';
  const abs = Math.abs(usd);
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * P19x.9 (29/04/2026) — Légende inline pour la colonne "Path" du Top 20.
 *
 * User spec : "Légende inline sous le tableau Top 20 (3 badges avec texte).
 * Tooltip au hover sur chaque rond expliquant la raison précise."
 *
 * Sémantique des badges :
 *   🟢 VERT   = path valide       — candidat éligible, gates passés
 *   🟡 JAUNE  = path partiel      — certains critères OK, autres bruyants
 *   🔴 ROUGE  = path bloqué       — gate critique échoué, pump-and-dump probable
 *
 * Les seuils numériques :
 *   smooth : pathEfficiency ≥ 0.7 ET pullbackDepth ≤ 1%
 *   choppy : pathEfficiency < 0.4 OU pullbackDepth > 2%
 *   mixed  : entre les deux
 */
function PathLegend() {
  const items: Array<{ emoji: string; label: string; tooltip: string }> = [
    {
      emoji: '🟢',
      label: 'Smooth',
      tooltip: 'Path valide — efficiency≥70% + pullback≤1%. Candidat éligible : tendance propre, peu de retracements.',
    },
    {
      emoji: '🟡',
      label: 'Mixed',
      tooltip: 'Path partiel — au moins 1 TF smooth ET au moins 1 TF noisy. Acceptable si gates persistence/efficacité passent.',
    },
    {
      emoji: '🔴',
      label: 'Choppy',
      tooltip: 'Path bloqué — efficiency<40% OU pullback>2%. Pump-and-dump probable. Rejeté par le gate path quality.',
    },
    {
      emoji: '⚪',
      label: 'Idle',
      tooltip: 'Données figées — marché fermé ou prix constants. Path non évaluable, exclu des statistiques.',
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground border-t pt-1.5">
      <span className="font-medium">Path :</span>
      {items.map((item) => (
        <span
          key={item.emoji}
          className="inline-flex items-center gap-1 cursor-help"
          title={item.tooltip}
        >
          <span>{item.emoji}</span>
          <span>{item.label}</span>
        </span>
      ))}
      <span
        className="text-muted-foreground/70 italic cursor-help"
        title="Score = persistenceCount/availableTFs. Ex: 6/6 = positif sur les 6 TFs (1m,5m,10m,15m,30m,1h). 3/5 = positif sur 3 des 5 TFs disponibles (1m souvent absent sur equities post-P19v)."
      >
        · Score = persist/total
      </span>
    </div>
  );
}

/**
 * PR Counters jour (Option B) — Bloc compteurs activité scanner sur la
 * journée UTC en cours, refresh synchrone avec le poll useGainersStatus 30s.
 *
 * Affiche :
 *   - 3 compteurs principaux (Scannés / Ouverts / Fermés + PnL fermé)
 *   - Sparkline 7j (évolution scannés/jour)
 *   - Breakdown 4 asset classes (US / EU / Asia / Crypto)
 */
function DailyCountersPanel({
  data,
  countdown,
}: {
  data: GainersStatus;
  countdown: number;
}) {
  const refreshIn = countdown % 30 === 0 ? 30 : countdown % 30;
  const closedPnlClass =
    data.closedTodayPnlUsd > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : data.closedTodayPnlUsd < 0
        ? 'text-red-600 dark:text-red-400'
        : 'text-muted-foreground';

  return (
    <div className="rounded-md border bg-card/50 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Aujourd&apos;hui · UTC
        </p>
        <p className="text-[10px] text-muted-foreground tabular-nums">
          Refresh dans: {refreshIn}s
        </p>
      </div>

      {/* 3 main counters */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <CounterBox
          icon="📡"
          label="Scannés"
          value={data.scannedToday}
          hint={breakdownInline(data.scannedByAssetClass)}
        />
        <CounterBox
          icon="✅"
          label="Ouverts"
          value={data.openedToday}
          hint={breakdownInline(data.openedByAssetClass)}
        />
        <CounterBox
          icon="💰"
          label="Fermés"
          value={data.closedToday}
          hint={
            data.closedToday > 0
              ? formatPnl(data.closedTodayPnlUsd)
              : breakdownInline(data.closedByAssetClass)
          }
          hintClass={data.closedToday > 0 ? closedPnlClass : ''}
        />
      </div>

      {/* Sparkline 7j */}
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground">
          Activité scanner 7 derniers jours
        </p>
        <Sparkline7d data={data.scanned7d} />
      </div>
    </div>
  );
}

function CounterBox({
  icon,
  label,
  value,
  hint,
  hintClass,
}: {
  icon: string;
  label: string;
  value: number;
  hint?: string;
  hintClass?: string;
}) {
  return (
    <div className="rounded border bg-background p-2 space-y-0.5">
      <div className="text-base">{icon}</div>
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
        {label}
      </div>
      <div className="text-base font-bold tabular-nums">{value}</div>
      {hint && (
        <div className={`text-[9px] ${hintClass ?? 'text-muted-foreground'}`}>
          {hint}
        </div>
      )}
    </div>
  );
}

function breakdownInline(b: GainersStatus['scannedByAssetClass']): string {
  // Affiche uniquement les asset classes non-zéro pour économiser de l'espace
  const parts: string[] = [];
  if (b.us > 0) parts.push(`US ${b.us}`);
  if (b.eu > 0) parts.push(`EU ${b.eu}`);
  if (b.asia > 0) parts.push(`AS ${b.asia}`);
  if (b.crypto > 0) parts.push(`₿ ${b.crypto}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function Sparkline7d({ data }: { data: Array<{ date: string; count: number }> }) {
  if (data.length === 0) return <p className="text-[10px] text-muted-foreground">—</p>;
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-1 h-10">
      {data.map((d) => {
        const heightPct = (d.count / max) * 100;
        const dayLabel = new Date(d.date).toLocaleDateString('fr-FR', { weekday: 'short' });
        return (
          <div
            key={d.date}
            className="flex-1 flex flex-col items-center gap-0.5"
            title={`${d.date} : ${d.count} candidats`}
          >
            <div
              className="w-full bg-orange-500/60 rounded-t-sm transition-all"
              style={{ height: `${Math.max(heightPct, 2)}%` }}
            />
            <span className="text-[8px] text-muted-foreground">{dayLabel.slice(0, 1).toUpperCase()}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * PR #243 — Bandeau trajectory_status pour Adaptive Selectivity.
 *
 * Affiche l'état courant + valeurs effectives :
 *   🟢 DANS_LE_PLAN      : "Trajectoire conforme · réalisé/cible X%"
 *   🟢 EN_AVANCE         : "En avance ✓ · réalisé X% / cible Y%"
 *   🟡 EN_RETARD         : "Mode rattrapage actif · gates assouplis"
 *   🚨 HORS_TRAJECTOIRE + scanner stoppé : alarme rouge sobre
 *   🟠 HORS_TRAJECTOIRE mais scanner encore actif : warning orange (transition)
 */
function TrajectoryBandeau({ status }: { status: GainersStatus }) {
  const { trajectoryStatus, adaptiveActive, realised7dPct, target7dPct } = status;
  if (!trajectoryStatus) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        ⏳ Adaptive Selectivity activé · trajectory en cours de calcul (cycle 5min)
      </div>
    );
  }
  const realisedStr = realised7dPct != null ? `${realised7dPct.toFixed(2)}%` : '—';
  const targetStr = target7dPct != null ? `${target7dPct.toFixed(2)}%` : '—';
  const ratioPct = (realised7dPct != null && target7dPct != null && target7dPct !== 0)
    ? Math.round((realised7dPct / target7dPct) * 100)
    : null;

  // Alarme rouge SOBRE — déclenchée uniquement si :
  //   1. Trajectory HORS_TRAJECTOIRE (problème identifié)
  //   2. ET autopilot effectivement désactivé (scanner réellement stoppé)
  // Sans la condition #2, on est dans une transition (service va arrêter au
  // prochain cycle 5min) → orange warning, pas rouge alarmiste.
  const scannerActuallyStopped = !status.adaptiveEnabled || status.adaptiveActive === false;
  const realScannerOff = trajectoryStatus === 'HORS_TRAJECTOIRE' && status.openPositions === 0;

  if (trajectoryStatus === 'HORS_TRAJECTOIRE' && realScannerOff) {
    // Vraie alarme — scanner stoppé, action requise
    return (
      <div className="rounded-md border-2 border-red-500 bg-red-50 dark:bg-red-950/30 px-3 py-2">
        <div className="flex items-start gap-2">
          <span className="text-base" aria-hidden>⚠️</span>
          <div className="flex-1 text-xs">
            <span className="font-semibold text-red-700 dark:text-red-300">
              Scanner arrêté
            </span>
            <span className="text-red-600 dark:text-red-400">
              {' · '}Trajectoire négative ({realisedStr}). Vérifie la stratégie avant relance.
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (trajectoryStatus === 'HORS_TRAJECTOIRE') {
    // Transition — trajectoire négative détectée mais scanner pas encore arrêté
    return (
      <div className="rounded-md border border-orange-400 bg-orange-50 dark:bg-orange-950/20 px-3 py-2">
        <div className="flex items-start gap-2 text-xs">
          <span aria-hidden>🟠</span>
          <span className="text-orange-700 dark:text-orange-300">
            <strong>Trajectoire négative détectée</strong> · Réalisé 7j {realisedStr}.
            Le service adaptive arrêtera le scanner au prochain cycle si non résolu.
          </span>
        </div>
      </div>
    );
  }

  if (trajectoryStatus === 'EN_RETARD') {
    return (
      <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-950/30 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="text-xl" aria-hidden>🟡</span>
          <div className="flex-1">
            <div className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
              {adaptiveActive ? 'Mode rattrapage ACTIF' : 'EN RETARD — adjustement en cours'}
            </div>
            <div className="text-xs text-yellow-700 dark:text-yellow-400 mt-1">
              Réalisé 7j {realisedStr} / cible {targetStr}{ratioPct != null ? ` (${ratioPct}%)` : ''}.
              {adaptiveActive
                ? ' Gates assouplis automatiquement (persistence −0.05, path_eff −0.05, max_per_cycle +1, cooldown ÷2). Restore au retour DANS_LE_PLAN.'
                : ' Le service va assouplir les gates au prochain cycle (5 min).'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // DANS_LE_PLAN ou EN_AVANCE — bandeau vert sobre
  const isAvance = trajectoryStatus === 'EN_AVANCE';
  return (
    <div className="rounded-md border border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-base" aria-hidden>🟢</span>
        <div className="text-xs">
          <span className="font-semibold text-emerald-700 dark:text-emerald-300">
            {isAvance ? 'EN AVANCE ✓' : 'DANS LE PLAN'}
          </span>
          <span className="text-muted-foreground">
            {' · '}Réalisé 7j {realisedStr} / cible {targetStr}
            {ratioPct != null ? ` (${ratioPct}%)` : ''}
            {' · '}Seuils user respectés
          </span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PR #246 — Cartes Gains du jour / Gains du mois (mode-agnostique).
// Source : paper_trades closed pour la strategy gainers (mode 'gainers').
// Restauration du widget que l'utilisateur avait dans le panneau Daily
// Harvest (mode 'harvest'), désormais visible aussi en mode 'gainers'.
// ═══════════════════════════════════════════════════════════════════

function DailyGainsCard({ data }: { data: GainersStatus }) {
  const total = data.closedTodayPnlUsd;
  const isPositive = total >= 0;
  const sign = isPositive ? '+' : '';
  return (
    <div className="rounded-lg border p-4 space-y-3 bg-emerald-50/50 dark:bg-emerald-950/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          <h3 className="text-sm font-medium">Gains du jour</h3>
        </div>
        <span className="text-[10px] text-muted-foreground">UTC</span>
      </div>
      <div className="space-y-1">
        <div className={`text-2xl font-mono font-bold tabular-nums ${isPositive ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}`}>
          {sign}${total.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {data.closedToday} trade{data.closedToday > 1 ? 's' : ''} fermé{data.closedToday > 1 ? 's' : ''} aujourd&apos;hui
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Ouverts</div>
          <div className="font-mono font-medium">{data.openedToday}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Fermés</div>
          <div className="font-mono font-medium">{data.closedToday}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Open</div>
          <div className="font-mono font-medium">{data.openPositions}/{data.maxPositions}</div>
        </div>
      </div>
    </div>
  );
}

function MonthlyGainsCard({ data }: { data: GainersStatus }) {
  const total = data.mtdPnlUsd ?? 0;
  const isPositive = total >= 0;
  const sign = isPositive ? '+' : '';
  const monthLabel = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const winRateMonth = data.mtdSessionsCount > 0
    ? (data.mtdWinningDays / data.mtdSessionsCount) * 100
    : 0;
  return (
    <div className="rounded-lg border p-4 space-y-3 bg-blue-50/50 dark:bg-blue-950/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-blue-700 dark:text-blue-300" />
          <h3 className="text-sm font-medium">Gains du mois</h3>
        </div>
        <span className="text-xs text-muted-foreground capitalize">{monthLabel}</span>
      </div>
      <div className="space-y-1">
        <div className={`text-2xl font-mono font-bold tabular-nums ${isPositive ? 'text-blue-700 dark:text-blue-300' : 'text-red-600'}`}>
          {sign}${total.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {data.mtdSessionsCount} jour{data.mtdSessionsCount > 1 ? 's' : ''} actif{data.mtdSessionsCount > 1 ? 's' : ''} ·{' '}
          {data.mtdWinningDays} +{' '}
          {data.mtdLosingDays} -{' '}
          {data.mtdSessionsCount > 0 && (
            <span className="font-medium">{winRateMonth.toFixed(0)}% jours gagnants</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Meilleur jour</div>
          <div className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
            {data.mtdBestDay && data.mtdBestDay.pnl > 0
              ? `+$${data.mtdBestDay.pnl.toFixed(2)}`
              : '—'}
          </div>
          {data.mtdBestDay && data.mtdBestDay.pnl > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {new Date(data.mtdBestDay.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pire jour</div>
          <div className="font-mono font-medium text-red-600">
            {data.mtdWorstDay && data.mtdWorstDay.pnl < 0
              ? `-$${Math.abs(data.mtdWorstDay.pnl).toFixed(2)}`
              : '—'}
          </div>
          {data.mtdWorstDay && data.mtdWorstDay.pnl < 0 && (
            <div className="text-[10px] text-muted-foreground">
              {new Date(data.mtdWorstDay.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades MTD</div>
          <div className="font-mono font-medium">{data.mtdTradesCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win rate jours</div>
          <div className="font-mono font-medium">
            {data.mtdSessionsCount > 0 ? `${winRateMonth.toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PR #258 — Carte Gains annuels (YTD) — conserve les gains au-delà
// de la fin de mois. Reset uniquement au 1er janvier UTC.
// ═══════════════════════════════════════════════════════════════════

function YearlyGainsCard({ data }: { data: GainersStatus }) {
  const total = data.ytdPnlUsd ?? 0;
  const isPositive = total >= 0;
  const sign = isPositive ? '+' : '';
  const yearLabel = new Date().getUTCFullYear();
  const winRateMonths = data.ytdMonthsCount > 0
    ? (data.ytdWinningMonths / data.ytdMonthsCount) * 100
    : 0;
  const formatMonthLabel = (m: string | undefined) => {
    if (!m) return '—';
    const [y, mm] = m.split('-');
    const date = new Date(Number(y), Number(mm) - 1, 1);
    return date.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  };
  return (
    <div className="rounded-lg border p-4 space-y-3 bg-violet-50/50 dark:bg-violet-950/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-violet-700 dark:text-violet-300" />
          <h3 className="text-sm font-medium">Gains annuels</h3>
        </div>
        <span className="text-xs text-muted-foreground">{yearLabel}</span>
      </div>
      <div className="space-y-1">
        <div className={`text-2xl font-mono font-bold tabular-nums ${isPositive ? 'text-violet-700 dark:text-violet-300' : 'text-red-600'}`}>
          {sign}${total.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {data.ytdMonthsCount} mois actif{data.ytdMonthsCount > 1 ? 's' : ''} ·{' '}
          {data.ytdWinningMonths} +{' '}
          {data.ytdLosingMonths} -{' '}
          {data.ytdMonthsCount > 0 && (
            <span className="font-medium">{winRateMonths.toFixed(0)}% mois gagnants</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Meilleur mois</div>
          <div className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
            {data.ytdBestMonth && data.ytdBestMonth.pnl > 0
              ? `+$${data.ytdBestMonth.pnl.toFixed(2)}`
              : '—'}
          </div>
          {data.ytdBestMonth && data.ytdBestMonth.pnl > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {formatMonthLabel(data.ytdBestMonth.month)}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pire mois</div>
          <div className="font-mono font-medium text-red-600">
            {data.ytdWorstMonth && data.ytdWorstMonth.pnl < 0
              ? `-$${Math.abs(data.ytdWorstMonth.pnl).toFixed(2)}`
              : '—'}
          </div>
          {data.ytdWorstMonth && data.ytdWorstMonth.pnl < 0 && (
            <div className="text-[10px] text-muted-foreground">
              {formatMonthLabel(data.ytdWorstMonth.month)}
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades YTD</div>
          <div className="font-mono font-medium">{data.ytdTradesCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win rate mois</div>
          <div className="font-mono font-medium">
            {data.ytdMonthsCount > 0 ? `${winRateMonths.toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PR #258 — Indicateur quota EODHD (auto-pause à 85% / 95%).
// ═══════════════════════════════════════════════════════════════════

function EodhdQuotaIndicator() {
  const { data } = useEodhdQuota();
  if (!data) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        ⏳ Chargement quota EODHD…
      </div>
    );
  }
  const used = data.authoritative.apiRequests;
  const limit = data.authoritative.dailyRateLimit;
  const pct = limit > 0 ? (used / limit) * 100 : 0;

  let color: string;
  let bg: string;
  let icon: string;
  let label: string;
  if (pct >= 100) {
    color = 'text-red-700 dark:text-red-300';
    bg = 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-800';
    icon = '🔴'; label = 'HARD BLOCK';
  } else if (pct >= 99) {
    color = 'text-red-600 dark:text-red-400';
    bg = 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900';
    icon = '🔴'; label = 'Mode essentials only';
  } else if (pct >= 95) {
    color = 'text-orange-700 dark:text-orange-300';
    bg = 'bg-orange-50 dark:bg-orange-950/20 border-orange-200 dark:border-orange-900';
    icon = '🟠'; label = 'Multi-TF auto-pause';
  } else if (pct >= 85) {
    color = 'text-amber-700 dark:text-amber-300';
    bg = 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900';
    icon = '🟡'; label = 'Scanner auto-pause';
  } else if (pct >= 70) {
    color = 'text-yellow-700 dark:text-yellow-300';
    bg = 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-900';
    icon = '⚠️'; label = 'Warning';
  } else {
    color = 'text-emerald-700 dark:text-emerald-300';
    bg = 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900';
    icon = '🟢'; label = 'Nominal';
  }

  return (
    <div className={`rounded-md border px-3 py-2 ${bg}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className={`h-4 w-4 ${color}`} />
          <span className={`text-xs font-medium ${color}`}>
            {icon} EODHD quota: {used.toLocaleString()} / {limit.toLocaleString()} ({pct.toFixed(1)}%)
          </span>
          <span className="text-[10px] text-muted-foreground">· {label}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {data.local.burnRatePerMin > 0 && (
            <span>burn: {data.local.burnRatePerMin.toFixed(0)} calls/min</span>
          )}
          {data.etaExhaustionMinutes != null && data.etaExhaustionMinutes < 720 && (
            <span className="text-orange-600 dark:text-orange-400">
              · ETA exhaustion: {Math.floor(data.etaExhaustionMinutes / 60)}h{(data.etaExhaustionMinutes % 60).toFixed(0)}m
            </span>
          )}
        </div>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={`h-full transition-all ${
            pct >= 95 ? 'bg-red-500' : pct >= 85 ? 'bg-amber-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {data.throttle.pauseReason && (
        <div className={`mt-1.5 text-[10px] ${color}`}>
          ⏸ {data.throttle.pauseReason}
        </div>
      )}
    </div>
  );
}
