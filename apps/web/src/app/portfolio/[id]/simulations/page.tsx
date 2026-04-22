'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Shuffle, TrendingUp, Loader2 } from 'lucide-react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { BackButton } from '@/components/ui/back-button';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface RebalanceTrade {
  ticker: string;
  assetClass: string;
  currentValue: string;
  targetValue: string;
  delta: string;
  currentWeight: number;
  targetWeight: number;
}

interface RebalancePreview {
  totalValue: string;
  currency: string;
  trades: RebalanceTrade[];
  estimatedCost: string;
  simulatedAt: string;
}

interface ContributionPreview {
  contributionAmount: string;
  currency: string;
  totalValueBefore: string;
  totalValueAfter: string;
  suggestedBuys: Array<{
    ticker: string;
    assetClass: string;
    suggestedAmount: string;
    currentWeight: number;
    targetWeight: number;
  }>;
  simulatedAt: string;
}

async function getToken(): Promise<string | null> {
  const supabase = createSupabaseBrowserClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export default function SimulationsPage() {
  const { id: portfolioId } = useParams<{ id: string }>();
  const [tab, setTab] = useState<'rebalance' | 'contribution'>('rebalance');
  const [loading, setLoading] = useState(false);
  const [rebalanceResult, setRebalanceResult] = useState<RebalancePreview | null>(null);
  const [contributionResult, setContributionResult] = useState<ContributionPreview | null>(null);
  const [contributionAmount, setContributionAmount] = useState('500');
  const [currency, setCurrency] = useState('EUR');
  const [error, setError] = useState<string | null>(null);

  async function runRebalance() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/simulations/rebalance-preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Erreur');
      setRebalanceResult(json.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function runContribution() {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/portfolio/${portfolioId}/simulations/contribution-preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ amount: contributionAmount, currency }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? 'Erreur');
      setContributionResult(json.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <DisclaimerBanner />

      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Simulations</h1>
          <p className="text-sm text-muted-foreground">
            Ces simulations sont indicatives et ne constituent pas un conseil en investissement.
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-b">
        <button
          onClick={() => setTab('rebalance')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === 'rebalance' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          <Shuffle className="h-4 w-4" />
          Rééquilibrage
        </button>
        <button
          onClick={() => setTab('contribution')}
          className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === 'contribution' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        >
          <TrendingUp className="h-4 w-4" />
          Versement
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {tab === 'rebalance' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Simulez un rééquilibrage vers l'allocation cible de votre profil de risque.
          </p>
          <Button onClick={runRebalance} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Shuffle className="mr-2 h-4 w-4" />}
            Simuler le rééquilibrage
          </Button>

          {rebalanceResult && (
            <div className="rounded-lg border">
              <div className="border-b p-4">
                <p className="text-sm text-muted-foreground">
                  Valeur totale : <strong>{parseFloat(rebalanceResult.totalValue).toFixed(2)} {rebalanceResult.currency}</strong>
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Actif</th>
                    <th className="px-4 py-2 text-right font-medium">Actuel</th>
                    <th className="px-4 py-2 text-right font-medium">Cible</th>
                    <th className="px-4 py-2 text-right font-medium">Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {rebalanceResult.trades.map((t, i) => {
                    const delta = parseFloat(t.delta);
                    return (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <span className="font-medium">{t.ticker}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{t.assetClass}</span>
                        </td>
                        <td className="px-4 py-2 text-right">{(t.currentWeight * 100).toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right">{(t.targetWeight * 100).toFixed(1)}%</td>
                        <td className={`px-4 py-2 text-right font-medium ${delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-500' : ''}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(2)} {rebalanceResult.currency}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'contribution' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Simulez un versement et obtenez une suggestion d'allocation.
          </p>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium">Montant</label>
              <input
                type="number"
                value={contributionAmount}
                onChange={(e) => setContributionAmount(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                min="1"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Devise</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="rounded-md border bg-background px-3 py-2 text-sm"
              >
                {['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'BTC'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>

          <Button onClick={runContribution} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TrendingUp className="mr-2 h-4 w-4" />}
            Simuler le versement
          </Button>

          {contributionResult && (
            <div className="rounded-lg border">
              <div className="border-b p-4">
                <p className="text-sm text-muted-foreground">
                  Versement de <strong>{contributionResult.contributionAmount} {contributionResult.currency}</strong>
                  {' '}— Valeur après versement :{' '}
                  <strong>{parseFloat(contributionResult.totalValueAfter).toFixed(2)} {contributionResult.currency}</strong>
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Actif suggéré</th>
                    <th className="px-4 py-2 text-right font-medium">Poids actuel</th>
                    <th className="px-4 py-2 text-right font-medium">Cible</th>
                    <th className="px-4 py-2 text-right font-medium">Montant suggéré</th>
                  </tr>
                </thead>
                <tbody>
                  {contributionResult.suggestedBuys.map((b, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <span className="font-medium">{b.ticker}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{b.assetClass}</span>
                      </td>
                      <td className="px-4 py-2 text-right">{(b.currentWeight * 100).toFixed(1)}%</td>
                      <td className="px-4 py-2 text-right">{(b.targetWeight * 100).toFixed(1)}%</td>
                      <td className="px-4 py-2 text-right font-medium text-emerald-600">
                        +{parseFloat(b.suggestedAmount).toFixed(2)} {contributionResult.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
