'use client';

import { useState } from 'react';
import {
  TrendingUp,
  ShieldCheck,
  Target,
  Lock,
  AlertTriangle,
  Calendar,
  CalendarDays,
  CalendarRange,
  RotateCcw,
} from 'lucide-react';
import { useDailyHarvest, type HarvestState } from '@/hooks/use-daily-harvest';
import { useGainersStatus } from '@/hooks/use-operating-mode';
import { useHarvestDisplayOffset } from '@/hooks/use-harvest-display-offset';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const STATE_DISPLAY: Record<HarvestState, { label: string; icon: typeof Target; color: string; bg: string }> = {
  IDLE: { label: 'En attente', icon: Target, color: 'text-slate-600', bg: 'bg-slate-100 dark:bg-slate-900/40' },
  ACTIVE: { label: 'Session active', icon: TrendingUp, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/40' },
  TARGET_NEAR: { label: 'Objectif proche', icon: TrendingUp, color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950/40' },
  TARGET_HIT: { label: 'Objectif atteint', icon: ShieldCheck, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/40' },
  PROFIT_SWEEP_PENDING: { label: 'Sweep en cours', icon: ShieldCheck, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/40' },
  PROFIT_SWEPT: { label: 'Profits sécurisés', icon: ShieldCheck, color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-950/40' },
  DAILY_LOCKED: { label: 'Session verrouillée', icon: Lock, color: 'text-violet-600', bg: 'bg-violet-50 dark:bg-violet-950/40' },
  LOSS_LIMIT_HIT: { label: 'Perte max atteinte', icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/40' },
  SESSION_CLOSED: { label: 'Session fermée', icon: Lock, color: 'text-slate-600', bg: 'bg-slate-100 dark:bg-slate-900/40' },
};

export function DailyHarvestTracker({ portfolioId }: { portfolioId: string }) {
  const query = useDailyHarvest(portfolioId);
  // PR #347 — YTD source : useGainersStatus (GainersStatus expose ytdPnlUsd + ytdTradesCount + ytdMonthsCount).
  // Secured YTD non agrégé côté backend → 0 placeholder (la card affiche un footnote dédié).
  // enabled=true : on a déjà filtré query.data.mode==='DAILY_HARVEST' au-dessus, le hook gainers-status est
  // safe à appeler (l'endpoint répond aussi en mode harvest).
  const gainersStatusQuery = useGainersStatus(portfolioId, true);
  const { offset, setRebase, clearRebase } = useHarvestDisplayOffset(portfolioId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Mode pas actif → pas de widget
  if (!query.data || query.data.mode !== 'DAILY_HARVEST' || !query.data.progress || !query.data.session) {
    return null;
  }

  const { progress, session, vault, cumulativeStats } = query.data;
  const stateDisplay = STATE_DISPLAY[progress.state];
  const Icon = stateDisplay.icon;

  // PR #347 — YTD côté frontend : useTradingStats (TradingStatsResponse) expose ytdPnlUsd seulement.
  // Secured YTD non agrégé côté backend → 0 placeholder (la card affiche un footnote dédié).
  const ytdRealizedRaw = gainersStatusQuery.data?.ytdPnlUsd ?? 0;
  const ytdSecuredRaw = 0;
  const ytdTradesCount = gainersStatusQuery.data?.ytdTradesCount ?? 0;
  const ytdMonthsCount = gainersStatusQuery.data?.ytdMonthsCount ?? 0;

  // PR #347 — valeurs ajustées par offset client localStorage (8 montants).
  const dailyRealizedRaw = cumulativeStats?.daily.realized ?? 0;
  const dailySecuredRaw = cumulativeStats?.daily.secured ?? 0;
  const mtdRealizedRaw = cumulativeStats?.mtd.realized ?? 0;
  const mtdSecuredRaw = cumulativeStats?.mtd.secured ?? 0;

  const realizedTodayAdj = progress.realizedToday - (offset?.realizedToday ?? 0);
  const securedTodayAdj = progress.securedToday - (offset?.securedToday ?? 0);
  const dailyRealizedAdj = dailyRealizedRaw - (offset?.dailyRealized ?? 0);
  const dailySecuredAdj = dailySecuredRaw - (offset?.dailySecured ?? 0);
  const mtdRealizedAdj = mtdRealizedRaw - (offset?.mtdRealized ?? 0);
  const mtdSecuredAdj = mtdSecuredRaw - (offset?.mtdSecured ?? 0);
  const ytdRealizedAdj = ytdRealizedRaw - (offset?.ytdRealized ?? 0);
  const ytdSecuredAdj = ytdSecuredRaw - (offset?.ytdSecured ?? 0);

  // Progression objectif recalculée sur valeur ajustée.
  const progressPctAdj =
    progress.targetAmountUsd > 0 ? (realizedTodayAdj / progress.targetAmountUsd) * 100 : 0;
  const remainingToTargetAdj = progress.targetAmountUsd - realizedTodayAdj;
  const progressClamped = Math.min(100, Math.max(0, progressPctAdj));
  const isOverTarget = progressPctAdj > 100;

  const handleRebaseConfirm = () => {
    setRebase({
      realizedToday: progress.realizedToday,
      securedToday: progress.securedToday,
      dailyRealized: dailyRealizedRaw,
      dailySecured: dailySecuredRaw,
      mtdRealized: mtdRealizedRaw,
      mtdSecured: mtdSecuredRaw,
      ytdRealized: ytdRealizedRaw,
      ytdSecured: ytdSecuredRaw,
    });
    setConfirmOpen(false);
  };

  return (
    <div className="space-y-3">
    <div className={`rounded-lg border p-4 space-y-3 ${stateDisplay.bg}`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${stateDisplay.color}`} />
          <h2 className="text-sm font-medium">DAILY HARVEST</h2>
          <span className={`text-xs font-mono uppercase tracking-wide ${stateDisplay.color}`}>
            {stateDisplay.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground font-mono">
            Session du {new Date(session.sessionDate).toLocaleDateString('fr-FR')}
          </span>
          {offset && (
            <span className="text-[10px] text-amber-700 dark:text-amber-300 font-mono">
              Rebasé depuis{' '}
              {new Date(offset.rebasedAt).toLocaleString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
          {offset ? (
            <button
              type="button"
              onClick={clearRebase}
              title="Annuler la remise à zéro de l'affichage"
              className="inline-flex items-center gap-1 h-7 px-2 rounded border text-[11px] hover:bg-muted/50"
            >
              <RotateCcw className="h-3 w-3" />
              Annuler rebase
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              title="Remettre à zéro l'affichage des gains (jour, mois, année + objectif) sans toucher à la DB"
              className="inline-flex items-center gap-1 h-7 px-2 rounded border text-[11px] hover:bg-muted/50"
            >
              <RotateCcw className="h-3 w-3" />
              Remise à zéro affichage
            </button>
          )}
        </div>
      </div>

      {/* Barre de progression vers l'objectif (valeurs ajustées) */}
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-xs text-muted-foreground">Progression vers l&apos;objectif</span>
          <span className={`text-sm font-mono font-medium ${realizedTodayAdj >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}`}>
            {realizedTodayAdj >= 0 ? '+' : ''}${realizedTodayAdj.toFixed(2)}
            {' / '}
            <span className="text-muted-foreground">${progress.targetAmountUsd.toFixed(2)}</span>
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className={`h-full transition-all ${isOverTarget ? 'bg-emerald-500' : progressClamped >= 80 ? 'bg-amber-500' : 'bg-blue-500'}`}
            style={{ width: `${progressClamped}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
          <span>{progressPctAdj.toFixed(0)}% atteint</span>
          <span>
            {remainingToTargetAdj > 0
              ? `Reste $${remainingToTargetAdj.toFixed(2)} à faire`
              : `Dépassé de +$${Math.abs(remainingToTargetAdj).toFixed(2)}`}
          </span>
        </div>
      </div>

      {/* Métriques en grille */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-current/10 text-xs">
        <Metric
          label="Vault sécurisé jour"
          value={`$${securedTodayAdj.toFixed(2)}`}
          color="text-emerald-700 dark:text-emerald-300"
          tooltip="Profits transférés hors capital de trading. Non réinjectables."
        />
        <Metric
          label="Vault total"
          value={vault ? `$${parseFloat(vault.totalSecuredUsd).toFixed(2)}` : '$0.00'}
          color="text-emerald-700 dark:text-emerald-300"
          tooltip={`${vault?.sweepCount ?? 0} sweep(s) cumulé(s)`}
        />
        <Metric
          label="Trades aujourd'hui"
          value={`${session.tradesCount}${progress.tradesRemainingBeforeCap != null ? ` / ${session.tradesCount + progress.tradesRemainingBeforeCap}` : ''}`}
          color="text-foreground"
          tooltip={`${session.winningTradesCount}W / ${session.losingTradesCount}L`}
        />
        <Metric
          label={progress.lossRemainingBeforeLock != null ? 'Marge avant lock' : 'État'}
          value={
            progress.lossRemainingBeforeLock != null
              ? `$${progress.lossRemainingBeforeLock.toFixed(2)}`
              : progress.isLocked ? 'Verrouillé' : 'Libre'
          }
          color={progress.isLocked ? 'text-red-600' : 'text-foreground'}
          tooltip={
            progress.lossRemainingBeforeLock != null
              ? 'Distance avant déclenchement LOSS_LIMIT_HIT'
              : ''
          }
        />
      </div>

      {/* Footer — dernière transition */}
      {session.lastStateTransitionReason && (
        <div className="text-[11px] text-muted-foreground italic pt-2 border-t border-current/10">
          {session.lastStateTransitionReason.slice(0, 200)}
        </div>
      )}
    </div>

    {/* Cartes cumuls : jour + mois + année (PR #347) */}
    {cumulativeStats && (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <DailyCumulCard
          stats={cumulativeStats}
          target={progress.targetAmountUsd}
          realizedAdj={dailyRealizedAdj}
          securedAdj={dailySecuredAdj}
        />
        <MonthlyCumulCard
          stats={cumulativeStats}
          realizedAdj={mtdRealizedAdj}
          securedAdj={mtdSecuredAdj}
        />
        <YearlyCumulCard
          realizedAdj={ytdRealizedAdj}
          securedAdj={ytdSecuredAdj}
          tradesCount={ytdTradesCount}
          monthsCount={ytdMonthsCount}
        />
      </div>
    )}

    <ConfirmDialog
      open={confirmOpen}
      title="Remettre à zéro l'affichage des gains ?"
      description="Cette action capture les valeurs courantes des 4 zones (jour, mois, année + objectif) comme baseline locale. L'affichage soustraira ensuite cette baseline tant qu'elle est active. AUCUNE modification de la base de données : les crons et l'historique complet de lisa_positions ne sont pas impactés. Tu peux annuler ce rebase en un clic à tout moment."
      onConfirm={handleRebaseConfirm}
      onCancel={() => setConfirmOpen(false)}
      confirmLabel="Remettre à zéro l'affichage"
      cancelLabel="Annuler"
    />

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CARTE — Gains journaliers cumulés
// ═══════════════════════════════════════════════════════════════════

function DailyCumulCard(props: {
  stats: NonNullable<ReturnType<typeof useDailyHarvest>['data']>['cumulativeStats'];
  target: number;
  realizedAdj: number;
  securedAdj: number;
}) {
  const stats = props.stats;
  if (!stats) return null;

  const { daily } = stats;
  const totalToday = props.realizedAdj;
  const isPositive = totalToday >= 0;
  const sign = isPositive ? '+' : '';
  const targetReached = props.target > 0 && totalToday >= props.target;

  return (
    <div className="rounded-lg border p-4 space-y-3 bg-emerald-50/50 dark:bg-emerald-950/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          <h3 className="text-sm font-medium">Gains du jour</h3>
        </div>
        {targetReached && (
          <span className="text-xs bg-emerald-600 text-white rounded px-2 py-0.5 font-medium">
            Cible atteinte
          </span>
        )}
      </div>

      <div className="space-y-1">
        <div className={`text-2xl font-mono font-bold tabular-nums ${isPositive ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}`}>
          {sign}${totalToday.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {props.target > 0 ? (
            <>Cible: ${props.target.toFixed(2)} · {((totalToday / props.target) * 100).toFixed(0)}%</>
          ) : (
            <>Pas de cible définie</>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sécurisé</div>
          <div className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
            ${props.securedAdj.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades</div>
          <div className="font-mono font-medium">{daily.tradesCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win rate</div>
          <div className="font-mono font-medium">
            {daily.tradesCount > 0 ? `${daily.winRate.toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CARTE — Gains mensuels cumulés
// ═══════════════════════════════════════════════════════════════════

function MonthlyCumulCard(props: {
  stats: NonNullable<ReturnType<typeof useDailyHarvest>['data']>['cumulativeStats'];
  realizedAdj: number;
  securedAdj: number;
}) {
  const stats = props.stats;
  if (!stats) return null;

  const { mtd, bestDay, worstDay } = stats;
  const isPositive = props.realizedAdj >= 0;
  const sign = isPositive ? '+' : '';
  const monthLabel = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const winRateMonth = mtd.sessionsCount > 0
    ? (mtd.winningDays / mtd.sessionsCount) * 100
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
          {sign}${props.realizedAdj.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {mtd.sessionsCount} session{mtd.sessionsCount > 1 ? 's' : ''} ·{' '}
          {mtd.winningDays} jour{mtd.winningDays > 1 ? 's' : ''} +{' '}
          {mtd.losingDays} jour{mtd.losingDays > 1 ? 's' : ''} -{' '}
          {mtd.sessionsCount > 0 && (
            <span className="font-medium">{winRateMonth.toFixed(0)}% jours gagnants</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Meilleur jour</div>
          <div className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
            {bestDay && bestDay.pnl > 0
              ? `+$${bestDay.pnl.toFixed(2)}`
              : '—'}
          </div>
          {bestDay && bestDay.pnl > 0 && (
            <div className="text-[10px] text-muted-foreground">
              {new Date(bestDay.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pire jour</div>
          <div className="font-mono font-medium text-red-600">
            {worstDay && worstDay.pnl < 0
              ? `-$${Math.abs(worstDay.pnl).toFixed(2)}`
              : '—'}
          </div>
          {worstDay && worstDay.pnl < 0 && (
            <div className="text-[10px] text-muted-foreground">
              {new Date(worstDay.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Vault MTD</div>
          <div className="font-mono font-medium text-emerald-700 dark:text-emerald-300">
            ${props.securedAdj.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades MTD</div>
          <div className="font-mono font-medium">{mtd.tradesCount}</div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PR #347 — CARTE — Gains annuels cumulés (YTD)
// ═══════════════════════════════════════════════════════════════════

function YearlyCumulCard(props: {
  realizedAdj: number;
  securedAdj: number;
  tradesCount: number;
  monthsCount: number;
}) {
  const isPositive = props.realizedAdj >= 0;
  const sign = isPositive ? '+' : '';
  const yearLabel = new Date().toLocaleDateString('fr-FR', { year: 'numeric' });

  return (
    <div className="rounded-lg border p-4 space-y-3 bg-violet-50/50 dark:bg-violet-950/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-violet-700 dark:text-violet-300" />
          <h3 className="text-sm font-medium">Gains de l&apos;année</h3>
        </div>
        <span className="text-xs text-muted-foreground">{yearLabel}</span>
      </div>

      <div className="space-y-1">
        <div className={`text-2xl font-mono font-bold tabular-nums ${isPositive ? 'text-violet-700 dark:text-violet-300' : 'text-red-600'}`}>
          {sign}${props.realizedAdj.toFixed(2)}
        </div>
        <div className="text-xs text-muted-foreground">
          {props.monthsCount} mois actif{props.monthsCount > 1 ? 's' : ''} ·{' '}
          {props.tradesCount} trade{props.tradesCount > 1 ? 's' : ''}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-current/10 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Vault YTD</div>
          <div className="font-mono font-medium text-violet-700 dark:text-violet-300">
            ${props.securedAdj.toFixed(2)}
          </div>
          <div className="text-[9px] text-muted-foreground italic">
            secured agrégé non disponible
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Trades YTD</div>
          <div className="font-mono font-medium">{props.tradesCount}</div>
        </div>
      </div>
    </div>
  );
}

function Metric(props: { label: string; value: string; color: string; tooltip?: string }) {
  return (
    <div className="space-y-0.5" title={props.tooltip}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      <div className={`font-mono font-medium tabular-nums ${props.color}`}>
        {props.value}
      </div>
    </div>
  );
}
