'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { X, BookOpen, FlaskConical, Sparkles, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'smartvest_welcome_dismissed_v1';

const STEPS = [
  {
    icon: FlaskConical,
    label: 'Découvrez la simulation',
    description: 'Testez des stratégies sans engager d\'argent réel.',
    href: '/help/simuler-sans-risque' as Route,
  },
  {
    icon: BookOpen,
    label: 'Lisez votre tableau de bord',
    description: 'Comprenez chaque indicateur affiché.',
    href: '/help/lire-votre-tableau-de-bord' as Route,
  },
  {
    icon: Sparkles,
    label: 'Configurez Lisa',
    description: 'Choisissez votre mode stratégique et démarrez les simulations.',
    href: '/help/configurer-lisa' as Route,
  },
] as const;

export function WelcomeBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (!dismissed) setVisible(true);
    } catch {
      // localStorage indisponible (SSR, private browsing)
    }
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {}
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-primary">Bienvenue sur SmartVest !</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Voici 3 étapes pour bien démarrer.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          aria-label="Fermer ce message de bienvenue"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, label, description, href }, i) => (
          <Link
            key={href}
            href={href}
            className="group flex items-start gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:bg-muted/50"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <span className="text-xs font-bold">{i + 1}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium leading-tight">{label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground leading-tight">{description}</p>
            </div>
            <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </Link>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <Link
          href={'/help/glossaire' as Route}
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Consulter le glossaire (42 termes)
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Ne plus afficher
        </button>
      </div>
    </div>
  );
}
