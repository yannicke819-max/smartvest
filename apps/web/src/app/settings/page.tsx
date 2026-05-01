'use client';

import type { Route } from 'next';
import Link from 'next/link';
import {
  Bell,
  Bot,
  Cable,
  ChevronRight,
  CreditCard,
  Database,
  Lock,
  Shield,
  Sliders,
  User,
  Zap,
} from 'lucide-react';
import { useIsAdmin } from '@/hooks/use-is-admin';

const PROFILE_SECTIONS = [
  {
    href: '/settings/profil',
    icon: User,
    label: 'Mon profil',
    description: 'Prénom, niveau d\'expérience, langue.',
  },
  {
    href: '/settings/securite',
    icon: Lock,
    label: 'Sécurité',
    description: 'Mot de passe, sessions actives.',
  },
  {
    href: '/settings/notifications',
    icon: Bell,
    label: 'Notifications',
    description: 'Alertes email, résumés hebdomadaires.',
  },
  {
    href: '/settings/abonnement',
    icon: CreditCard,
    label: 'Abonnement',
    description: 'Plan actuel, limites et informations de facturation.',
  },
  {
    href: '/settings/donnees',
    icon: Database,
    label: 'Mes données',
    description: 'Exporter ou supprimer votre compte (RGPD).',
  },
] as const;

const ADVANCED_SECTIONS = [
  {
    href: '/settings/delegation',
    icon: Shield,
    label: 'Délégation & Mandats',
    description: "Garde-fous et mandats d'autonomie pour Lisa.",
  },
  {
    href: '/settings/strategy-mode',
    icon: Sliders,
    label: 'Mode stratégique',
    description: "Mode d'analyse : investissement, harvest ou gainers.",
  },
  {
    href: '/settings/hyper-trading',
    icon: Bot,
    label: 'Hyper-trading',
    description: 'Analyse haute fréquence — opt-in strict, garde-fous renforcés.',
  },
  {
    href: '/settings/sniper',
    icon: Zap,
    label: 'Mode sniper',
    description: 'Session courte durée pour un suivi intensif temporaire.',
  },
  {
    href: '/settings/brokers',
    icon: Cable,
    label: 'Connexions brokers',
    description: 'Connectez vos comptes brokers en lecture seule.',
  },
] as const;

function SectionList({ sections }: { sections: readonly { href: string; icon: React.ElementType; label: string; description: string }[] }) {
  return (
    <div className="rounded-lg border divide-y">
      {sections.map(({ href, icon: Icon, label, description }) => (
        <Link
          key={href}
          href={href as Route}
          className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/30"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </Link>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const isAdmin = useIsAdmin();

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Mon compte</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configurez votre espace SmartVest.
        </p>
      </div>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">Profil & préférences</p>
        <SectionList sections={PROFILE_SECTIONS} />
      </section>

      {isAdmin && (
        <section className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground px-1">Réglages avancés</p>
          <SectionList sections={ADVANCED_SECTIONS} />
        </section>
      )}
    </div>
  );
}
