'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';

type Mode = 'single_shot' | 'walk_forward' | 'auto_apply';

interface Candidate {
  antiConsensusStrength: number;
  maxPositionSizePct: number;
  maxAssetClassExposurePct: number;
  stopLossPct: number;
  takeProfitPct: number;
}

interface ScoredCandidate {
  candidate: Candidate;
  metrics: {
    sharpeRatio: number;
    totalReturnPct: number;
    maxDrawdownPct: number;
    winRatePct: number;
    profitFactor: number;
    totalTrades: number;
  };
  compositeScore: number;
  stabilityScore?: number;
  oosScore?: number;
}

interface ApplyDecision {
  willApply: boolean;
  reasonCode: string;
  reasonText: string;
  appliedConfig?: Candidate;
  scoreCurrent?: number;
  scoreNew?: number;
}

interface OptimizerRunResult {
  mode: Mode;
  fromDate: string;
  toDate: string;
  durationMs: number;
  candidatesTested: number;
  leaderboard: { ranked: ScoredCandidate[]; best: ScoredCandidate | null };
  applyDecision?: ApplyDecision;
  warnings: string[];
}

interface AutoState {
  enabled: boolean;
  lastRunAt: string | null;
  lastApplyAt: string | null;
  lastMode: Mode | null;
}

interface RunHistoryRow {
  id: string;
  mode: Mode;
  from_date: string;
  to_date: string;
  candidates_tested: number;
  best_score: number | null;
  applied: boolean;
  duration_ms: number;
  created_at: string;
}

function isoMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export default function OptimizerPage() {
  const [tab, setTab] = useState<Mode>('single_shot');
  const [fromDate, setFromDate] = useState(isoMinusDays(90));
  const [toDate, setToDate] = useState(isoMinusDays(1));
  const [trainRatio, setTrainRatio] = useState(0.6);
  const [maxCandidates, setMaxCandidates] = useState(15);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OptimizerRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoState, setAutoState] = useState<AutoState | null>(null);
  const [history, setHistory] = useState<RunHistoryRow[]>([]);

  useEffect(() => {
    void loadAutoState();
    void loadHistory();
  }, []);

  async function loadAutoState() {
    try {
      const s = await apiFetch<AutoState>('/optimizer/auto/state');
      setAutoState(s);
    } catch {
      // silencieux
    }
  }

  async function loadHistory() {
    try {
      const rows = await apiFetch<RunHistoryRow[]>('/optimizer/runs?limit=10');
      setHistory(rows);
    } catch {
      // silencieux
    }
  }

  async function handleRun() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<OptimizerRunResult>('/optimizer/run', {
        method: 'POST',
        body: JSON.stringify({
          mode: tab,
          fromDate,
          toDate,
          initialCapitalUsd: 10_000,
          trainRatio,
          maxCandidates,
        }),
      });
      setResult(res);
      void loadHistory();
      void loadAutoState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setRunning(false);
    }
  }

  // Set both dates : "X derniers jours" = aujourd'hui-X → aujourd'hui.
  // Backtest = données passées uniquement (pas de futur disponible).
  const setQuickPeriod = (days: number) => {
    setFromDate(isoMinusDays(days));
    setToDate(isoMinusDays(0));
  };

  async function handleApply(c: Candidate) {
    try {
      await apiFetch('/optimizer/apply', {
        method: 'POST',
        body: JSON.stringify({ candidate: c }),
      });
      alert('Configuration appliquée à ta session Lisa.');
      void loadAutoState();
    } catch (e) {
      alert(`Apply échoué : ${e instanceof Error ? e.message : 'erreur'}`);
    }
  }

  async function handleToggleAuto() {
    if (!autoState) return;
    try {
      const next = await apiFetch<AutoState>('/optimizer/auto/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: !autoState.enabled }),
      });
      setAutoState(next);
    } catch (e) {
      alert(`Toggle échoué : ${e instanceof Error ? e.message : 'erreur'}`);
    }
  }

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Améliorer mon portefeuille</h1>
        <p className="text-sm text-muted-foreground">
          Test de configurations multiples sur données historiques. 3 modes sélectionnables.
        </p>
      </div>

      <div className="flex gap-2 border-b">
        <TabButton active={tab === 'single_shot'} onClick={() => setTab('single_shot')}>
          Phase A — Single-shot
        </TabButton>
        <TabButton active={tab === 'walk_forward'} onClick={() => setTab('walk_forward')}>
          Phase C — Walk-forward
        </TabButton>
        <TabButton active={tab === 'auto_apply'} onClick={() => setTab('auto_apply')}>
          Phase B — Auto-apply
        </TabButton>
      </div>

      <div className="rounded-lg border p-5 space-y-4">
        <ModeDescription mode={tab} />

        <p className="text-xs text-muted-foreground italic">
          Le backtest rejoue des données <strong>passées</strong> (EODHD historique).
          Les dates futures sont rejetées car aucune donnée n'existe encore.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Du (date passée)">
            <input
              type="date"
              value={fromDate}
              max={isoMinusDays(0)}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label="Au (jusqu'à aujourd'hui max)">
            <input
              type="date"
              value={toDate}
              max={isoMinusDays(0)}
              onChange={(e) => setToDate(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
            />
          </Field>
          <Field label={`Configs testées max : ${maxCandidates}`}>
            <input
              type="range"
              min={5}
              max={50}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </Field>
          {(tab === 'walk_forward' || tab === 'auto_apply') && (
            <Field label={`Train ratio (split train/val) : ${(trainRatio * 100).toFixed(0)}%`}>
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={trainRatio}
                onChange={(e) => setTrainRatio(parseFloat(e.target.value))}
                className="w-full"
              />
            </Field>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-2">Période rapide :</span>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(7)}>7 derniers jours</Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(30)}>30 derniers jours</Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(90)}>90 derniers jours</Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(180)}>6 derniers mois</Button>
          <Button variant="outline" size="sm" onClick={() => setQuickPeriod(365)}>1 dernière année</Button>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={running}>
            {running ? 'Run en cours…' : `Lancer ${tab.replace('_', ' ')}`}
          </Button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>

      {tab === 'auto_apply' && autoState && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm">État du mode auto-apply</h3>
            <Button
              size="sm"
              variant={autoState.enabled ? 'destructive' : 'default'}
              onClick={handleToggleAuto}
            >
              {autoState.enabled ? 'Désactiver auto-apply' : 'Activer auto-apply'}
            </Button>
          </div>
          <div className="text-xs space-y-1">
            <p>État : <strong>{autoState.enabled ? 'ACTIVÉ' : 'DÉSACTIVÉ'}</strong></p>
            <p>Dernier run : {autoState.lastRunAt ? new Date(autoState.lastRunAt).toLocaleString('fr-FR') : 'jamais'}</p>
            <p>Dernier apply : {autoState.lastApplyAt ? new Date(autoState.lastApplyAt).toLocaleString('fr-FR') : 'jamais'}</p>
            {autoState.enabled && (
              <p className="text-amber-900 dark:text-amber-200">
                Cron quotidien 03h05 UTC : tourne walk-forward 90j et applique si Sharpe gain &gt; 0.3, stable, cooldown 7j respecté.
              </p>
            )}
          </div>
        </div>
      )}

      {result && (
        <>
          {result.applyDecision && <ApplyDecisionCard decision={result.applyDecision} />}
          <Leaderboard result={result} onApply={handleApply} />
          {result.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 text-xs">
              {result.warnings.slice(0, 5).map((w, i) => <p key={i}>• {w}</p>)}
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="rounded-lg border p-5">
          <h2 className="font-medium mb-3 text-sm">Historique des runs</h2>
          <table className="w-full text-xs">
            <caption className="sr-only">Historique des runs d'optimisation</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="text-left py-1">Quand</th>
                <th scope="col" className="text-left py-1">Mode</th>
                <th scope="col" className="text-left py-1">Période</th>
                <th scope="col" className="text-right py-1">Configs</th>
                <th scope="col" className="text-right py-1">Best score</th>
                <th scope="col" className="text-right py-1">Durée</th>
                <th scope="col" className="text-left py-1">Applied</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-1">{new Date(r.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="py-1">{r.mode}</td>
                  <td className="py-1">{r.from_date} → {r.to_date}</td>
                  <td className="py-1 text-right">{r.candidates_tested}</td>
                  <td className="py-1 text-right">{r.best_score?.toFixed(2) ?? '—'}</td>
                  <td className="py-1 text-right">{(r.duration_ms / 1000).toFixed(1)}s</td>
                  <td className="py-1">{r.applied ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground block mb-1">{label}</span>
      {children}
    </label>
  );
}

function ModeDescription({ mode }: { mode: Mode }) {
  if (mode === 'single_shot') {
    return (
      <p className="text-xs text-muted-foreground">
        <strong>Phase A :</strong> teste une grille de configs sur la période entière. Rapide, simple, pas de validation out-of-sample. Pour exploration manuelle.
      </p>
    );
  }
  if (mode === 'walk_forward') {
    return (
      <p className="text-xs text-muted-foreground">
        <strong>Phase C :</strong> split train/validation, score sur la portion non vue (OOS), pondéré par stabilité (variance des sous-fenêtres). Anti-overfitting rigoureux.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      <strong>Phase B :</strong> walk-forward + évaluation des 4 garde-fous (significance &gt; 0.3 Sharpe, stabilité &gt; 0.6, cooldown 7j, pas de régime change). Applique automatiquement si tous OK. Cron quotidien si toggle activé.
    </p>
  );
}

function ApplyDecisionCard({ decision }: { decision: ApplyDecision }) {
  const color =
    decision.reasonCode === 'applied'
      ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20'
      : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20';
  return (
    <div className={`rounded-lg border ${color} p-4 space-y-2`}>
      <h3 className="font-medium text-sm">
        Décision auto-apply : {decision.willApply ? '✓ APPLIQUÉE' : '✗ SKIP'}
      </h3>
      <p className="text-xs">{decision.reasonText}</p>
      {decision.scoreCurrent != null && decision.scoreNew != null && (
        <p className="text-xs text-muted-foreground">
          Score courant : {decision.scoreCurrent.toFixed(2)} | Nouveau : {decision.scoreNew.toFixed(2)} | Delta : {(decision.scoreNew - decision.scoreCurrent).toFixed(2)}
        </p>
      )}
      {decision.appliedConfig && (
        <p className="text-xs font-mono">
          Config appliquée : antiCons={decision.appliedConfig.antiConsensusStrength}, maxPos={decision.appliedConfig.maxPositionSizePct}%, maxClass={decision.appliedConfig.maxAssetClassExposurePct}%, stop={decision.appliedConfig.stopLossPct}%, tp={decision.appliedConfig.takeProfitPct}%
        </p>
      )}
    </div>
  );
}

function Leaderboard({ result, onApply }: { result: OptimizerRunResult; onApply: (c: Candidate) => void }) {
  const top = result.leaderboard.ranked.slice(0, 10);
  return (
    <div className="rounded-lg border p-5">
      <div className="flex justify-between items-baseline mb-3">
        <h2 className="font-medium">Leaderboard ({result.candidatesTested} configs testées)</h2>
        <span className="text-xs text-muted-foreground">Run en {(result.durationMs / 1000).toFixed(1)}s</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <caption className="sr-only">Top 10 configurations triées par score composite</caption>
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="text-left py-1">#</th>
              <th scope="col" className="text-right py-1">Score</th>
              <th scope="col" className="text-right py-1" title="Sharpe ratio">Sharpe</th>
              <th scope="col" className="text-right py-1" title="Max drawdown (%)"><abbr title="Drawdown maximum">DD</abbr>%</th>
              <th scope="col" className="text-right py-1">Return%</th>
              <th scope="col" className="text-right py-1">Win%</th>
              <th scope="col" className="text-right py-1" title="Profit factor"><abbr title="Profit factor">PF</abbr></th>
              <th scope="col" className="text-center py-1" title="Force anti-consensus"><abbr title="Force anti-consensus">AntiCons</abbr></th>
              <th scope="col" className="text-center py-1" title="Max position size (%)"><abbr title="Max position size">Pos</abbr>%</th>
              <th scope="col" className="text-center py-1" title="Max exposure per asset class (%)"><abbr title="Max exposure per asset class">Class</abbr>%</th>
              <th scope="col" className="text-center py-1">Stop</th>
              <th scope="col" className="text-center py-1" title="Take-profit"><abbr title="Take-profit">TP</abbr></th>
              {result.mode !== 'single_shot' && <th scope="col" className="text-right py-1" title="Score de stabilité"><abbr title="Score de stabilité">Stab</abbr></th>}
              <th scope="col" className="text-center py-1">Action</th>
            </tr>
          </thead>
          <tbody>
            {top.map((s, i) => (
              <tr key={i} className={`border-b last:border-0 ${i === 0 ? 'bg-emerald-50 dark:bg-emerald-950/20' : ''}`}>
                <td className="py-1">{i + 1}</td>
                <td className="py-1 text-right font-medium">{s.compositeScore.toFixed(2)}</td>
                <td className="py-1 text-right">{s.metrics.sharpeRatio.toFixed(2)}</td>
                <td className="py-1 text-right">{s.metrics.maxDrawdownPct.toFixed(1)}</td>
                <td className={`py-1 text-right ${s.metrics.totalReturnPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{s.metrics.totalReturnPct.toFixed(1)}</td>
                <td className="py-1 text-right">{s.metrics.winRatePct.toFixed(0)}</td>
                <td className="py-1 text-right">{Number.isFinite(s.metrics.profitFactor) ? s.metrics.profitFactor.toFixed(2) : '∞'}</td>
                <td className="py-1 text-center">{s.candidate.antiConsensusStrength}</td>
                <td className="py-1 text-center">{s.candidate.maxPositionSizePct}</td>
                <td className="py-1 text-center">{s.candidate.maxAssetClassExposurePct}</td>
                <td className="py-1 text-center">{s.candidate.stopLossPct}</td>
                <td className="py-1 text-center">{s.candidate.takeProfitPct}</td>
                {result.mode !== 'single_shot' && (
                  <td className="py-1 text-right">{s.stabilityScore?.toFixed(2) ?? '—'}</td>
                )}
                <td className="py-1 text-center">
                  <button
                    onClick={() => onApply(s.candidate)}
                    className="text-blue-600 hover:underline text-xs"
                  >
                    Appliquer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
