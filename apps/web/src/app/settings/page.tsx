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

// Implements ADR-003 — Settings V2 information architecture
// 4 sections par axe d'impact : profil & accès / données & confidentialité /
// stratégie & objectifs (admin) / délégation & exécution (admin).
// Routes inchangées — pas de breaking change pour les bookmarks.

interface SectionItem {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
}

const PROFILE_ACCESS_SECTIONS: readonly SectionItem[] = [
  {
    href: '/settings/profil',
    icon: User,
    label: 'Mon profil',
    description: "Prénom, niveau d'expérience, langue.",
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
] as const;

const STRATEGY_SECTIONS: readonly SectionItem[] = [
  {
    href: '/settings/strategy-mode',
    icon: Sliders,
    label: 'Mode stratégique',
    description: "Cadence d'analyse et intensité du risque.",
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
] as const;

const DELEGATION_EXECUTION_SECTIONS: readonly SectionItem[] = [
  {
    href: '/settings/delegation',
    icon: Shield,
    label: 'Délégation & mandats',
    description: "Mandats d'autonomie et kill-switch pour Lisa.",
  },
  {
    href: '/settings/brokers',
    icon: Cable,
    label: 'Connexions brokers',
    description: 'Connectez vos comptes brokers en lecture seule.',
  },
] as const;

function SectionList({ sections }: { sections: readonly SectionItem[] }) {
  return (
    <div className="rounded-lg border divide-y">
      {sections.map(({ href, icon: Icon, label, description }) => (
        <Link
          key={href}
          href={href as Route}
          className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}

// Section RGPD mise en avant (ADR-003 §4 nuance 2) — card unique enrichie
// pour compenser le faible volume (1 item) et signaler la conformité.
function PrivacySectionCard() {
  return (
    <Link
      href={'/settings/donnees' as Route}
      className="block rounded-lg border border-blue-200 bg-blue-50/40 p-4 transition-colors hover:bg-blue-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 dark:border-blue-900/40 dark:bg-blue-950/10 dark:hover:bg-blue-950/20"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-white dark:border-blue-800 dark:bg-blue-950/40">
          <Database className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Exporter ou supprimer mes données</p>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Téléchargez l'intégralité de vos données SmartVest (portefeuilles,
            transactions, profil) au format JSON, ou demandez la suppression
            définitive de votre compte. Conformité RGPD garantie.
          </p>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      </div>
    </Link>
  );
}

export default function SettingsPage() {
  const isAdmin = useIsAdmin();

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Mon compte</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configurez votre espace SmartVest.
        </p>
      </header>

      <section className="space-y-2" aria-labelledby="settings-section-profile">
        <h2
          id="settings-section-profile"
          className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Mon profil &amp; accès
        </h2>
        <SectionList sections={PROFILE_ACCESS_SECTIONS} />
      </section>

      <section className="space-y-2" aria-labelledby="settings-section-privacy">
        <h2
          id="settings-section-privacy"
          className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Mes données &amp; confidentialité
        </h2>
        <PrivacySectionCard />
      </section>

      {isAdmin && (
        <>
          <section className="space-y-2" aria-labelledby="settings-section-strategy">
            <h2
              id="settings-section-strategy"
              className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Stratégie &amp; objectifs
            </h2>
            <SectionList sections={STRATEGY_SECTIONS} />
          </section>

          <section className="space-y-2" aria-labelledby="settings-section-delegation">
            <h2
              id="settings-section-delegation"
              className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Délégation &amp; exécution
            </h2>
            <SectionList sections={DELEGATION_EXECUTION_SECTIONS} />
          </section>
        </>
      )}
    </div>
  );
}
