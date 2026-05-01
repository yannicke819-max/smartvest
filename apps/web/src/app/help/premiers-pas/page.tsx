'use client';

import Link from 'next/link';
import { type Route } from 'next';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';

const STEPS = [
  {
    title: 'Créez votre portefeuille',
    body: 'Rendez-vous dans "Mon portefeuille" et ajoutez vos positions actuelles (actions, ETF, crypto…). SmartVest calcule automatiquement votre exposition et votre diversification.',
  },
  {
    title: 'Consultez votre tableau de bord',
    body: 'La page d\'accueil résume votre situation : valeur totale, évolution récente, répartition par classe d\'actif. Tout est mis à jour à chaque chargement.',
  },
  {
    title: 'Explorez les projections',
    body: 'La section "Projections futures" simule différents scénarios pour votre portefeuille sur 1, 5 ou 10 ans. Ce sont des simulations, pas des prédictions.',
  },
  {
    title: 'Activez l\'assistant Lisa',
    body: 'Lisa analyse votre portefeuille et vous soumet des suggestions. Vous restez toujours décisionnaire : Lisa propose, vous validez ou refusez.',
  },
  {
    title: 'Configurez vos notifications',
    body: 'Dans "Mes notifications", définissez les alertes qui comptent pour vous : seuils de perte, opportunités de marché, rappels de rééquilibrage.',
  },
];

export default function PremiersPasPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Premiers pas</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prenez SmartVest en main en 5 étapes simples.
        </p>
      </div>

      <ol className="space-y-4">
        {STEPS.map((step, i) => (
          <li key={i} className="flex gap-4 rounded-lg border p-4">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {i + 1}
            </div>
            <div>
              <p className="text-sm font-medium">{step.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-3 rounded-lg border border-dashed p-4">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          SmartVest est un outil d'aide à la décision. Il ne passe aucun ordre en votre nom
          sans votre accord explicite. Les performances passées ne préjugent pas des
          performances futures.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 border-t pt-4">
        <Link
          href={'/help/faq' as Route}
          className="flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
        >
          Questions fréquentes <ChevronRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={'/help/risques' as Route}
          className="flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
        >
          Comprendre les risques <ChevronRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={'/help/glossaire' as Route}
          className="flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
        >
          Glossaire <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
