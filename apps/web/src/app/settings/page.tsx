'use client';

import Link from 'next/link';
import {
  Bot,
  Cable,
  ChevronRight,
  Shield,
  Sliders,
  Zap,
} from 'lucide-react';

const SECTIONS = [
  {
    href: '/settings/delegation',
    icon: Shield,
    label: 'Délégation & Mandats',
    description: "Configurez les garde-fous et mandats d'autonomie.",
  },
  {
    href: '/settings/strategy-mode',
    icon: Sliders,
    label: 'Mode stratégique',
    description: "Choisissez le mode d'analyse et de cadence.",
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

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Paramètres</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configurez votre espace SmartVest.
        </p>
      </div>

      <div className="rounded-lg border divide-y">
        {SECTIONS.map(({ href, icon: Icon, label, description }) => (
          <Link
            key={href}
            href={href}
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
    </div>
  );
}
