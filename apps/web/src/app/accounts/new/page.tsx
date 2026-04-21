'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { usePortfolios } from '@/hooks/use-portfolio';
import { createAccount } from '@/app/actions/portfolio';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ACCOUNT_KINDS = [
  { value: 'brokerage', label: 'Compte titres ordinaire' },
  { value: 'pea', label: 'PEA' },
  { value: 'cash', label: 'Compte espèces' },
  { value: 'crypto_exchange', label: 'Exchange crypto' },
  { value: 'wallet', label: 'Wallet auto-hébergé' },
  { value: 'ira', label: 'Retraite (IRA, PER…)' },
  { value: 'other', label: 'Autre' },
];

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'BTC', 'ETH'];

export default function AddAccountPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Chargement…</div>}>
      <AddAccountPageInner />
    </Suspense>
  );
}

function AddAccountPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const portfoliosQuery = usePortfolios();
  const portfolios = portfoliosQuery.data ?? [];

  const [portfolioId, setPortfolioId] = useState(params.get('portfolioId') ?? '');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('brokerage');
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!portfolioId) { setError('Sélectionnez un portefeuille.'); return; }
    setLoading(true);
    setError(null);
    try {
      await createAccount({ portfolioId, label, kind, accountCurrency: currency });
      router.push(`/portfolio/${portfolioId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur.');
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ajouter un compte</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Déclarez un compte broker, exchange ou wallet manuellement.
          Aucune connexion API n'est requise à ce stade.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Informations du compte</CardTitle>
          <CardDescription>
            Les données sont stockées localement dans Supabase — aucune donnée n'est
            envoyée à un broker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Portefeuille parent</label>
              <select
                value={portfolioId}
                onChange={(e) => setPortfolioId(e.target.value)}
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Sélectionner…</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Nom du compte</label>
              <input
                type="text"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex : Bourse Direct — PEA"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Type</label>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  {ACCOUNT_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Devise</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => router.back()}>
                Annuler
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Enregistrement…' : 'Créer le compte'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
