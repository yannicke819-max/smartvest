import { ArrowDownRight, ArrowUpRight, Coins, LineChart, Scale, Wallet } from 'lucide-react';
import { DisclaimerBanner } from './disclaimer-banner';
import { KpiCard } from './kpi-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

export function DashboardPlaceholder() {
  return (
    <div className="space-y-6">
      <DisclaimerBanner />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Tableau de bord</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Vue d&apos;ensemble du portefeuille. Les chiffres ci-dessous sont des placeholders
          tant que la connexion aux comptes n&apos;est pas configurée.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Valeur totale"
          value="—"
          hint="Converti en devise de base (EUR)"
          icon={<Wallet className="h-4 w-4" />}
        />
        <KpiCard
          label="Performance globale"
          value="—"
          delta={{ value: '—', positive: true }}
          icon={<ArrowUpRight className="h-4 w-4" />}
        />
        <KpiCard
          label="Drift d'allocation"
          value="—"
          hint="Écart cumulé vs profil cible"
          icon={<Scale className="h-4 w-4" />}
        />
        <KpiCard
          label="Frictions 30j"
          value="—"
          hint="Frais, spreads, slippage, FX"
          icon={<Coins className="h-4 w-4" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Performance du portefeuille</CardTitle>
            <CardDescription>
              Graphique indisponible — aucun historique n&apos;est encore connecté.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-64 items-center justify-center text-muted-foreground">
            <LineChart className="mr-2 h-5 w-5" aria-hidden />
            <span>Courbe à venir</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prochaines étapes</CardTitle>
            <CardDescription>Connecter des comptes pour activer les vues.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Step label="Créer un premier portefeuille" />
            <Step label="Rattacher un compte broker ou un wallet" />
            <Step label="Importer l&apos;historique de transactions" />
            <Step label="Définir l&apos;allocation cible" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Step({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <ArrowDownRight className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
