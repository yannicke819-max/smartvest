import { cn } from '@/lib/utils';
import { HelpTip } from '@/components/ui/help-tip';

export type RiskProfile = 'prudent' | 'equilibre' | 'dynamique' | 'offensif' | 'sur_mesure';

interface RiskMeta {
  label: string;
  humanPhrase: string;
  description: string;
  color: string;
  emoji: string;
}

export const RISK_META: Record<RiskProfile, RiskMeta> = {
  prudent: {
    label: 'Prudent',
    humanPhrase: 'Je préserve mon capital avant tout',
    description:
      'Les simulations favorisent des actifs stables (obligations, or). Peu de volatilité, gains modérés sur le long terme.',
    color: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800',
    emoji: '🛡',
  },
  equilibre: {
    label: 'Équilibré',
    humanPhrase: 'Je cherche croissance et sécurité',
    description:
      'Répartition typique 60 % actions / 40 % obligations. Accepte des baisses passagères pour un rendement moyen à long terme.',
    color: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800',
    emoji: '⚖',
  },
  dynamique: {
    label: 'Dynamique',
    humanPhrase: "J'accepte la volatilité pour croître",
    description:
      "Majoritairement en actions. Tolère des corrections de −25 %. Potentiel de rendement élevé sur un horizon ≥ 5 ans.",
    color: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
    emoji: '📈',
  },
  offensif: {
    label: 'Offensif',
    humanPhrase: 'Je vise la performance maximale',
    description:
      'Forte exposition aux actifs risqués (croissance, crypto, small caps). Tolère des baisses de −50 % ou plus. Horizon long.',
    color: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800',
    emoji: '🚀',
  },
  sur_mesure: {
    label: 'Sur-mesure',
    humanPhrase: 'Profil personnalisé',
    description: 'Paramètres définis manuellement selon vos préférences et contraintes spécifiques.',
    color: 'bg-muted text-muted-foreground border-border',
    emoji: '✏',
  },
};

interface RiskBadgeProps {
  profile: RiskProfile | string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  showPhrase?: boolean;
  showTip?: boolean;
  className?: string;
}

export function RiskBadge({
  profile,
  size = 'md',
  showPhrase = false,
  showTip = true,
  className,
}: RiskBadgeProps) {
  const meta = profile ? RISK_META[profile as RiskProfile] : null;

  if (!meta) {
    return (
      <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground', className)}>
        Non défini
      </span>
    );
  }

  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-2.5 py-0.5',
    lg: 'text-base px-3 py-1',
  };

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border font-medium',
          sizeClasses[size],
          meta.color,
        )}
        aria-label={`Profil de simulation : ${meta.label}`}
      >
        <span aria-hidden>{meta.emoji}</span>
        {meta.label}
      </span>

      {showPhrase && (
        <span className="text-sm text-muted-foreground italic">{meta.humanPhrase}</span>
      )}

      {showTip && (
        <HelpTip
          text={meta.description}
          glossarySlug="profil-de-risque"
          side="right"
        />
      )}
    </span>
  );
}
