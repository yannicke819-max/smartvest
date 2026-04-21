'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plug, AlertTriangle, Lock, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { useCreateBrokerConnection, type BrokerProvider, type CreateConnectionPayload } from '@/hooks/use-brokers';
import { BackButton } from '@/components/ui/back-button';

const PROVIDERS: Array<{
  value: BrokerProvider; label: string; mode: 'live' | 'csv'; notes: string;
  website: string; category: 'broker' | 'crypto';
}> = [
  { value: 'MANUAL', label: 'Manuel / Autre', mode: 'csv', notes: 'Aucune connexion externe. Utilisez /imports pour charger des CSV.', website: '', category: 'broker' },
  // Actions / ETF / dérivés
  { value: 'INTERACTIVE_BROKERS', label: 'Interactive Brokers', mode: 'live', notes: 'Requiert le Client Portal Gateway local. accountId (ex: U1234567) + sessionToken.', website: 'https://www.interactivebrokers.com', category: 'broker' },
  { value: 'SAXO', label: 'Saxo Banque', mode: 'live', notes: 'OAuth2 — créer une app sur developer.saxo/. Fournir access_token + refresh_token + expiresAt.', website: 'https://www.home.saxo', category: 'broker' },
  { value: 'TRADING212', label: 'Trading 212', mode: 'live', notes: 'Générer une clé API depuis Settings → API (Invest / ISA).', website: 'https://www.trading212.com', category: 'broker' },
  { value: 'DEGIRO', label: 'DEGIRO', mode: 'csv', notes: 'Pas d\'API officielle. Exportez un CSV depuis le portail DEGIRO, puis utilisez /imports.', website: 'https://www.degiro.com', category: 'broker' },
  { value: 'TRADE_REPUBLIC', label: 'Trade Republic', mode: 'csv', notes: 'Broker mobile européen. Pas d\'API publique — export des transactions via l\'app, puis /imports.', website: 'https://traderepublic.com', category: 'broker' },
  { value: 'ETORO', label: 'eToro', mode: 'csv', notes: 'Social trading. Pas d\'API retail publique — export CSV via le portail.', website: 'https://www.etoro.com', category: 'broker' },
  { value: 'REVOLUT', label: 'Revolut', mode: 'csv', notes: 'Néobanque avec offre trading. Pas d\'API trading publique — export CSV depuis l\'app.', website: 'https://www.revolut.com', category: 'broker' },
  { value: 'BOURSE_DIRECT', label: 'Bourse Direct', mode: 'csv', notes: 'Broker français (PEA, CTO). Pas d\'API publique — CSV via /imports.', website: 'https://www.boursedirect.fr', category: 'broker' },
  { value: 'FORTUNEO', label: 'Fortuneo', mode: 'csv', notes: 'Banque en ligne française avec offre bourse. Pas d\'API publique — CSV via /imports.', website: 'https://www.fortuneo.fr', category: 'broker' },
  // Crypto
  { value: 'BINANCE', label: 'Binance', mode: 'csv', notes: 'Plus grande plateforme crypto. API REST disponible — adapter live à venir. En attendant, export CSV.', website: 'https://www.binance.com', category: 'crypto' },
  { value: 'KRAKEN', label: 'Kraken', mode: 'csv', notes: 'Exchange crypto US. API REST disponible — adapter live à venir. En attendant, export CSV.', website: 'https://www.kraken.com', category: 'crypto' },
  { value: 'COINBASE', label: 'Coinbase', mode: 'csv', notes: 'Exchange crypto coté en bourse. API Advanced Trade — adapter live à venir. En attendant, export CSV.', website: 'https://www.coinbase.com', category: 'crypto' },
  { value: 'CRYPTO_COM', label: 'Crypto.com', mode: 'csv', notes: 'Exchange crypto + Visa. Pas d\'API retail publique — export CSV.', website: 'https://crypto.com', category: 'crypto' },
];

export default function NewBrokerConnectionPage() {
  const router = useRouter();
  const create = useCreateBrokerConnection();
  const [provider, setProvider] = useState<BrokerProvider>('MANUAL');
  const [label, setLabel] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const selected = PROVIDERS.find((p) => p.value === provider)!;

  function set(k: string, v: string) {
    setForm((prev) => ({ ...prev, [k]: v }));
    setActionError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    if (!label.trim()) {
      setActionError('Libellé obligatoire.');
      return;
    }

    let payload: CreateConnectionPayload;
    switch (provider) {
      case 'MANUAL':
      case 'DEGIRO':
      case 'BOURSE_DIRECT':
      case 'FORTUNEO':
      case 'BINANCE':
      case 'KRAKEN':
      case 'COINBASE':
      case 'CRYPTO_COM':
      case 'TRADE_REPUBLIC':
      case 'ETORO':
      case 'REVOLUT':
        payload = {
          provider,
          label: label.trim(),
          credentials: provider === 'MANUAL'
            ? { provider: 'MANUAL', note: 'no-credentials' }
            : { provider, note: 'use-csv-import' },
        } as CreateConnectionPayload;
        break;
      case 'INTERACTIVE_BROKERS':
        if (!form.accountId || !form.sessionToken) {
          setActionError('accountId et sessionToken obligatoires.');
          return;
        }
        payload = {
          provider: 'INTERACTIVE_BROKERS',
          label: label.trim(),
          credentials: { provider: 'INTERACTIVE_BROKERS', accountId: form.accountId, sessionToken: form.sessionToken },
        };
        break;
      case 'SAXO':
        if (!form.oauthAccessToken || !form.oauthRefreshToken || !form.expiresAt) {
          setActionError('Access token, refresh token et expiresAt obligatoires.');
          return;
        }
        payload = {
          provider: 'SAXO',
          label: label.trim(),
          credentials: {
            provider: 'SAXO',
            oauthAccessToken: form.oauthAccessToken,
            oauthRefreshToken: form.oauthRefreshToken,
            expiresAt: new Date(form.expiresAt).toISOString(),
            ...(form.accountId ? { accountId: form.accountId } : {}),
          },
        };
        break;
      case 'TRADING212':
        if (!form.apiKey) {
          setActionError('Clé API obligatoire.');
          return;
        }
        payload = {
          provider: 'TRADING212',
          label: label.trim(),
          credentials: { provider: 'TRADING212', apiKey: form.apiKey, ...(form.accountId ? { accountId: form.accountId } : {}) },
        };
        break;
    }

    create.mutate(payload, {
      onSuccess: (row) => router.push(`/settings/brokers/${row.id}`),
      onError: (e) => setActionError((e as Error).message),
    });
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Plug className="h-5 w-5 text-muted-foreground" />
            Connecter un broker
          </h1>
          <p className="text-sm text-muted-foreground">
            Les credentials sont envoyés au serveur et stockés dans Supabase Vault immédiatement.
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {/* Vault notice */}
      <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-4 text-xs text-sky-900">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">Sécurité credentials</p>
          <p>
            Les identifiants saisis ici ne sont jamais stockés en base en clair, jamais journalisés,
            jamais renvoyés par l'API. Ils sont chiffrés dans Supabase Vault dès réception.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border p-5">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium">Broker</label>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as BrokerProvider);
              setForm({});
              setActionError(null);
            }}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="MANUAL">Manuel / Autre</option>
            <optgroup label="Actions, ETF, dérivés">
              {PROVIDERS.filter((p) => p.category === 'broker' && p.value !== 'MANUAL').map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </optgroup>
            <optgroup label="Crypto">
              {PROVIDERS.filter((p) => p.category === 'crypto').map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </optgroup>
          </select>
          <p className="text-[11px] text-muted-foreground">{selected.notes}</p>
          {selected.website && (
            <a
              href={selected.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Site officiel {selected.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium">Libellé</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="ex. IB Pro — EUR"
            required
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        {selected.mode === 'csv' && provider !== 'MANUAL' && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <p>
              <strong>{selected.label}</strong> ne fournit pas d'API officielle. La connexion sera
              créée sans credentials. Utilisez ensuite le flow d'import CSV dans{' '}
              <Link href="/imports" className="font-semibold underline">
                /imports <ExternalLink className="inline h-3 w-3" />
              </Link>
              .
            </p>
          </div>
        )}

        {provider === 'INTERACTIVE_BROKERS' && (
          <>
            <Field label="Account ID (ex. U1234567)" value={form.accountId ?? ''} onChange={(v) => set('accountId', v)} />
            <Field label="Session token" value={form.sessionToken ?? ''} onChange={(v) => set('sessionToken', v)} type="password" />
          </>
        )}

        {provider === 'SAXO' && (
          <>
            <Field label="OAuth access token" value={form.oauthAccessToken ?? ''} onChange={(v) => set('oauthAccessToken', v)} type="password" />
            <Field label="OAuth refresh token" value={form.oauthRefreshToken ?? ''} onChange={(v) => set('oauthRefreshToken', v)} type="password" />
            <Field label="Expiration du token" value={form.expiresAt ?? ''} onChange={(v) => set('expiresAt', v)} type="datetime-local" />
            <Field label="Account ID (optionnel)" value={form.accountId ?? ''} onChange={(v) => set('accountId', v)} />
          </>
        )}

        {provider === 'TRADING212' && (
          <>
            <Field label="API key" value={form.apiKey ?? ''} onChange={(v) => set('apiKey', v)} type="password" />
            <Field label="Account ID (optionnel)" value={form.accountId ?? ''} onChange={(v) => set('accountId', v)} />
          </>
        )}

        {actionError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {actionError}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Link href="/settings/brokers">
            <Button type="button" variant="outline">Annuler</Button>
          </Link>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Création…' : 'Créer la connexion'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text',
}: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      />
    </div>
  );
}
