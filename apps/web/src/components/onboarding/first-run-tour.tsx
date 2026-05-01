'use client';

import { useState, useEffect } from 'react';
import { type Route } from 'next';
import Link from 'next/link';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STORAGE_KEY = 'smartvest_first_run_tour_v1';

const STEPS = [
  {
    title: 'Bienvenue sur SmartVest',
    body: 'SmartVest vous aide à analyser et simuler votre portefeuille. Commençons par un tour rapide des fonctionnalités principales.',
    action: null,
  },
  {
    title: 'Mon portefeuille',
    body: 'Ajoutez vos actifs dans "Mon portefeuille". SmartVest calcule automatiquement votre exposition, votre diversification et vos performances.',
    action: { label: 'Aller à Mon portefeuille', href: '/portfolio' as Route },
  },
  {
    title: "L'assistant Lisa",
    body: 'Lisa analyse votre portefeuille et vous propose des pistes d\'optimisation. Vous restez toujours décisionnaire — Lisa suggère, vous validez.',
    action: { label: 'Découvrir Lisa', href: '/lisa' as Route },
  },
  {
    title: 'Simulations et projections',
    body: '"Tester sur le passé" et "Projections futures" vous permettent de simuler des scénarios sans engager de capital réel.',
    action: { label: 'Consulter les guides', href: '/help/premiers-pas' as Route },
  },
] as const;

export function FirstRunTour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setOpen(true);
      }
    } catch {
      // localStorage indisponible (SSR, private browsing)
    }
  }, []);

  function close() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch { /* noop */ }
    setOpen(false);
  }

  function next() {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      close();
    }
  }

  function prev() {
    if (step > 0) setStep(step - 1);
  }

  if (!open) return null;

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tour de découverte SmartVest"
    >
      <div className="relative w-full max-w-sm rounded-xl border bg-background shadow-lg">
        {/* Close */}
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Fermer le tour de découverte"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="p-6">
          {/* Step indicator */}
          <div className="mb-4 flex items-center gap-1.5" aria-hidden>
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i <= step ? 'bg-primary' : 'bg-muted'
                }`}
              />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Étape {step + 1} sur {STEPS.length}
          </p>
          <h2 className="mt-1 text-base font-semibold">{current.title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{current.body}</p>

          {current.action && (
            <Link
              href={current.action.href}
              onClick={close}
              className="mt-3 inline-block text-sm text-primary hover:underline underline-offset-4"
            >
              {current.action.label} →
            </Link>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between border-t px-6 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={prev}
            disabled={step === 0}
            aria-label="Étape précédente"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            Précédent
          </Button>

          <button
            type="button"
            onClick={close}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Passer
          </button>

          <Button size="sm" onClick={next}>
            {isLast ? 'Terminer' : 'Suivant'}
            {!isLast && <ChevronRight className="ml-1 h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
