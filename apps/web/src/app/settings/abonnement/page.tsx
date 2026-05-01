import type { Route } from 'next';
import Link from 'next/link';
import { BackButton } from '@/components/ui/back-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/ui/help-tip';
import { FlaskConical, Sparkles } from 'lucide-react';

export default function AbonnementPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Abonnement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Votre plan actuel et ses fonctionnalités.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FlaskConical className="h-4 w-4 text-amber-500" />
            Plan actuel — Simulation personnelle
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
            <p className="text-xs text-amber-800 dark:text-amber-300">
              SmartVest est actuellement en accès personnel gratuit.
              Toutes les fonctionnalités de simulation sont disponibles sans limite.
            </p>
          </div>

          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-500">✓</span>
              <span className="flex-1">Portefeuilles de simulation illimités</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-500">✓</span>
              <span className="flex flex-1 flex-wrap items-center gap-1">
                Analyse IA via Lisa <span className="text-xs">(sous quota d'API)</span>
                <HelpTip
                  text="Chaque analyse Lisa consomme un budget LLM. Vous pouvez consulter votre consommation quotidienne dans /lisa et le plafond est paramétrable."
                  glossarySlug="lisa"
                  side="right"
                />
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-500">✓</span>
              <span className="flex flex-1 flex-wrap items-center gap-1">
                Données de marché en différé (15 min)
                <HelpTip
                  text="Les cours affichés ont 15 minutes de retard sur les marchés temps réel. Pour le suivi long terme c'est sans impact ; pour du scalping intraday, ce délai est trop important — d'où le mode 'mode démo' sur les stratégies auto."
                  side="right"
                />
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-500">✓</span>
              <span className="flex-1">Guides utilisateur et glossaire</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-500">✓</span>
              <span className="flex flex-1 flex-wrap items-center gap-1">
                Export des données (RGPD)
                <HelpTip
                  text="Le RGPD garantit votre droit à récupérer toutes vos données personnelles au format JSON, ainsi qu'à demander leur suppression définitive. Voir Mon compte → Mes données."
                  side="right"
                />
              </span>
            </li>
          </ul>

          <div className="border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Les données de marché sont fournies par EODHD et Binance.
              Certaines données peuvent être en différé de 15 minutes.{' '}
              <Link
                href={'/legal/cgu' as Route}
                className="text-primary underline underline-offset-4"
              >
                Voir les CGU
              </Link>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            Fonctionnalités à venir
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {[
              'Connexion broker en lecture (Interactive Brokers, Saxo, Trading 212)',
              'Données temps réel',
              'Alertes SMS',
              'Rapports PDF personnalisés',
            ].map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                <span className="mt-0.5 text-muted-foreground/40">○</span>
                {feature}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
