'use client';

import { cn } from '@/lib/utils';
import { HelpTip } from '@/components/ui/help-tip';

// ADR-002 Sprint 3 — AssetRiskLevel : badge de risque d'actif/stratégie.
// Distinct du <RiskBadge> profil utilisateur (prudent/équilibré/dynamique/offensif).
// Ici : niveau de risque d'un actif ou d'une stratégie, mappé sur la
// volatilité annualisée historique. Pour M. Tout-le-monde : 4 paliers
// 🟢 faible / 🟡 modéré / 🟠 élevé / 🔴 extrême avec wording grand public.

export type AssetRiskLevel = 'low' | 'moderate' | 'high' | 'extreme';

interface LevelMeta {
  label: string;
  emoji: string;
  pill: string;          // background + text + border (badge)
  description: string;   // tooltip détaillé (vulgarisé)
  shortHint: string;     // sous-libellé optionnel
}

export const RISK_LEVEL_META: Record<AssetRiskLevel, LevelMeta> = {
  low: {
    label: 'Risque faible',
    emoji: '🟢',
    pill: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800',
    description:
      'Volatilité annualisée < 8 %. Variations typiques de l\'ordre de ±5 %/an. Adapté pour un horizon court ou un capital qu\'on ne peut pas se permettre de voir baisser. Exemples : obligations d\'État, fonds monétaires.',
    shortHint: '~5 %/an',
  },
  moderate: {
    label: 'Risque modéré',
    emoji: '🟡',
    pill: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
    description:
      'Volatilité annualisée 8-20 %. Baisses typiques de l\'ordre de −15 %, récupérées en 2-3 ans. Standard pour un investissement long terme diversifié. Exemples : ETF World, portefeuilles équilibrés 60/40.',
    shortHint: '~15 %, recovery 2-3 ans',
  },
  high: {
    label: 'Risque élevé',
    emoji: '🟠',
    pill: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800',
    description:
      'Volatilité annualisée 20-40 %. Baisses possibles de 30-50 %. À éviter sur un horizon < 5 ans. Exemples : actions individuelles, secteur tech concentré, crypto majeurs (BTC/ETH).',
    shortHint: '30-50 %, éviter <5 ans',
  },
  extreme: {
    label: 'Risque extrême',
    emoji: '🔴',
    pill: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800',
    description:
      'Volatilité annualisée > 40 %. Perte totale possible. Réservé aux investisseurs aguerris, sur une part marginale du patrimoine. Exemples : crypto altcoins, small caps spéculatives, levier élevé.',
    shortHint: 'perte totale possible',
  },
};

/**
 * Map annualized volatility (decimal fraction OR percent points) to one of
 * the 4 risk levels. Accepts either form via heuristic: values > 1 are
 * treated as percent points.
 */
export function levelFromVolatility(volAnnualized: number): AssetRiskLevel {
  if (!Number.isFinite(volAnnualized) || volAnnualized < 0) return 'moderate';
  const pct = volAnnualized > 1 ? volAnnualized : volAnnualized * 100;
  if (pct < 8) return 'low';
  if (pct < 20) return 'moderate';
  if (pct < 40) return 'high';
  return 'extreme';
}

/**
 * Fallback when only the historical max drawdown is known. Drawdown is
 * roughly 2× annualized vol on diversified equity baskets — we use this
 * heuristic to align bands with `levelFromVolatility`.
 *  DD < 10 %  → low
 *  DD < 25 %  → moderate
 *  DD < 50 %  → high
 *  DD ≥ 50 %  → extreme
 */
export function levelFromMaxDrawdown(maxDrawdownPct: number): AssetRiskLevel {
  if (!Number.isFinite(maxDrawdownPct) || maxDrawdownPct < 0) return 'moderate';
  const pct = maxDrawdownPct;
  if (pct < 10) return 'low';
  if (pct < 25) return 'moderate';
  if (pct < 50) return 'high';
  return 'extreme';
}

interface AssetRiskLevelProps {
  /** Volatilité annualisée — accepte fraction (0.18) ou points de % (18). */
  volatilityAnnualized?: number;
  /** Override manuel — prioritaire sur `volatilityAnnualized`. */
  level?: AssetRiskLevel;
  size?: 'sm' | 'md' | 'lg';
  /** Affiche le label texte à côté du badge pill (par défaut visible md/lg). */
  showLabel?: boolean;
  /** Affiche le sous-libellé court (~5 %/an, etc.) à droite. */
  showShortHint?: boolean;
  /** Affiche le tooltip d'aide intégré. */
  showTip?: boolean;
  className?: string;
}

export function AssetRiskLevel({
  volatilityAnnualized,
  level,
  size = 'md',
  showLabel = true,
  showShortHint = false,
  showTip = true,
  className,
}: AssetRiskLevelProps) {
  const resolvedLevel: AssetRiskLevel | null = level
    ?? (volatilityAnnualized != null ? levelFromVolatility(volatilityAnnualized) : null);

  if (!resolvedLevel) {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground',
          className,
        )}
      >
        Risque non évalué
      </span>
    );
  }

  const meta = RISK_LEVEL_META[resolvedLevel];

  const sizeClasses: Record<NonNullable<AssetRiskLevelProps['size']>, string> = {
    sm: 'text-xs px-2 py-0.5 gap-1',
    md: 'text-sm px-2.5 py-0.5 gap-1.5',
    lg: 'text-base px-3 py-1 gap-1.5',
  };

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <span
        className={cn(
          'inline-flex items-center rounded-full border font-medium',
          sizeClasses[size],
          meta.pill,
        )}
        aria-label={meta.label}
      >
        <span aria-hidden>{meta.emoji}</span>
        {showLabel && meta.label}
      </span>

      {showShortHint && (
        <span className="text-xs text-muted-foreground">{meta.shortHint}</span>
      )}

      {showTip && (
        <HelpTip
          text={meta.description}
          glossarySlug="volatilite"
          side="right"
        />
      )}
    </span>
  );
}
