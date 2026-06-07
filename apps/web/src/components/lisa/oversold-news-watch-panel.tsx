'use client';

import { Newspaper, ExternalLink } from 'lucide-react';
import { useOversoldNewsWatch, type OversoldNewsAlert } from '@/hooks/use-oversold-news-watch';

/**
 * PR-2 (widget 3) — Veille news contraires sur les positions oversold ouvertes.
 *
 * Surface les news à sentiment négatif récent (48h) sur les titres tenus, du
 * plus négatif au moins négatif. VISIBILITÉ uniquement : le mean-reversion tient
 * délibérément à travers le bruit (la chute initiale est souvent due à une
 * mauvaise news), donc ce panel n'auto-ferme RIEN — il aide l'utilisateur à
 * repérer un éventuel falling-knife qui s'aggrave, à arbitrer manuellement.
 */
export function OversoldNewsWatchPanel({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, isError } = useOversoldNewsWatch(portfolioId);

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📰 Chargement de la veille news…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        📰 Veille news indisponible pour le moment.
      </div>
    );
  }

  const shockCount = data.alerts.filter((a) => a.level === 'shock').length;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-purple-600" />
          <h2 className="text-sm font-medium">📰 Veille news — positions tenues</h2>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {data.alerts.length === 0
            ? `0 alerte · ${data.openPositions} position${data.openPositions > 1 ? 's' : ''}`
            : `${data.alerts.length} alerte${data.alerts.length > 1 ? 's' : ''}${shockCount > 0 ? ` (dont ${shockCount} 🔴)` : ''} · ${data.openPositions} position${data.openPositions > 1 ? 's' : ''}`}
        </span>
      </div>

      {data.alerts.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          {data.openPositions === 0
            ? 'Aucune position oversold ouverte.'
            : `Aucune news à sentiment contraire (≤ -0.3) sur les ${data.openPositions} position(s) tenue(s) ces ${data.windowHours} dernières heures.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {data.alerts.map((a) => (
            <AlertRow key={a.symbol} a={a} />
          ))}
        </ul>
      )}

      <p className="text-[11px] text-muted-foreground italic">
        Information seulement — le mode oversold tient ses positions à travers le bruit (hold J+10).
        Ce panel n&apos;auto-ferme rien ; il signale un éventuel <em>falling-knife</em> à arbitrer à la main.
        Fenêtre {data.windowHours}h · MAJ {new Date(data.asOf).toLocaleTimeString('fr-FR')}.
      </p>
    </div>
  );
}

function AlertRow({ a }: { a: OversoldNewsAlert }) {
  const shock = a.level === 'shock';
  const age =
    a.latestAgeHours == null
      ? '—'
      : a.latestAgeHours < 1
        ? `${Math.round(a.latestAgeHours * 60)} min`
        : `${a.latestAgeHours.toFixed(0)} h`;
  return (
    <li
      className={`rounded-md border p-2 text-xs ${
        shock ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex items-center gap-2">
        <span>{shock ? '🔴' : '🟡'}</span>
        <span className="font-medium">{a.symbol.replace('.US', '')}</span>
        <span
          className={`font-mono tabular-nums ${shock ? 'text-red-600' : 'text-amber-600'}`}
          title="Sentiment le plus négatif sur la fenêtre"
        >
          {a.minSentiment.toFixed(2)}
        </span>
        <span className="text-muted-foreground">
          · {a.articleCount} article{a.articleCount > 1 ? 's' : ''} · il y a {age}
        </span>
      </div>
      {a.latestTitle && (
        <div className="mt-1 text-muted-foreground line-clamp-2">
          {a.latestUrl ? (
            <a
              href={a.latestUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline inline-flex items-start gap-1"
            >
              {a.latestTitle}
              <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
            </a>
          ) : (
            a.latestTitle
          )}
        </div>
      )}
    </li>
  );
}
