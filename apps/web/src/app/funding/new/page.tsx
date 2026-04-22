'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DisclaimerBanner } from '@/components/disclaimer-banner';
import { BackButton } from '@/components/ui/back-button';
import {
  useFundingSources,
  useFundingDestinations,
  useCreateFundingTransfer,
} from '@/hooks/use-funding';

export default function NewFundingTransferPage() {
  const router = useRouter();
  const sourcesQuery = useFundingSources();
  const destinationsQuery = useFundingDestinations();
  const createMutation = useCreateFundingTransfer();

  const [form, setForm] = useState({
    destination_id: '',
    source_id: '',
    amount: '',
    currency: 'EUR',
    expected_settlement_date: '',
    reference: '',
    notes: '',
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  const destinations = (destinationsQuery.data ?? []).filter((d) => d.is_active);
  const sources = (sourcesQuery.data ?? []).filter((s) => s.is_active);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    setValidationError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.destination_id) {
      setValidationError('Sélectionnez un compte de destination.');
      return;
    }
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setValidationError('Montant invalide — entrez un nombre positif.');
      return;
    }
    createMutation.mutate(
      {
        destination_id: form.destination_id,
        amount: amt.toFixed(10),
        currency: form.currency.toUpperCase(),
        ...(form.source_id ? { source_id: form.source_id } : {}),
        ...(form.expected_settlement_date ? { expected_settlement_date: form.expected_settlement_date } : {}),
        ...(form.reference ? { reference: form.reference } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      },
      {
        onSuccess: (created) => {
          router.push(`/funding/${created.id}`);
        },
      },
    );
  }

  const isLoading = sourcesQuery.isLoading || destinationsQuery.isLoading;

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
            Nouveau transfert
          </h1>
          <p className="text-sm text-muted-foreground">
            Déclarez un virement vers un compte broker. Aucun ordre bancaire n'est passé par
            SmartVest.
          </p>
        </div>
      </div>

      <DisclaimerBanner />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border p-5">
          {/* Destination */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">
              Compte de destination <span className="text-destructive">*</span>
            </label>
            {destinations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Aucun compte actif.{' '}
                <Link href="/accounts/new" className="underline">
                  En créer un
                </Link>
                .
              </p>
            ) : (
              <select
                name="destination_id"
                value={form.destination_id}
                onChange={handleChange}
                required
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Sélectionner…</option>
                {destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.currency})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Source (optional) */}
          {sources.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium">Compte source (optionnel)</label>
              <select
                name="source_id"
                value={form.source_id}
                onChange={handleChange}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Aucun</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.currency})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Amount + Currency */}
          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <label className="block text-sm font-medium">
                Montant <span className="text-destructive">*</span>
              </label>
              <input
                type="number"
                name="amount"
                value={form.amount}
                onChange={handleChange}
                min="0.01"
                step="0.01"
                placeholder="0.00"
                required
                className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
              />
            </div>
            <div className="w-24 space-y-1.5">
              <label className="block text-sm font-medium">Devise</label>
              <input
                type="text"
                name="currency"
                value={form.currency}
                onChange={handleChange}
                maxLength={3}
                placeholder="EUR"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm uppercase"
              />
            </div>
          </div>

          {/* Expected settlement */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">
              Date de règlement prévue (optionnel)
            </label>
            <input
              type="date"
              name="expected_settlement_date"
              value={form.expected_settlement_date}
              onChange={handleChange}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          {/* Reference */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">Référence virement (optionnel)</label>
            <input
              type="text"
              name="reference"
              value={form.reference}
              onChange={handleChange}
              placeholder="ex. REF-2024-001"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">Notes (optionnel)</label>
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={2}
              placeholder="Commentaire libre…"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          {validationError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {validationError}
            </div>
          )}

          {createMutation.error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {(createMutation.error as Error).message}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Link href="/funding">
              <Button type="button" variant="outline">
                Annuler
              </Button>
            </Link>
            <Button type="submit" disabled={createMutation.isPending || destinations.length === 0}>
              {createMutation.isPending ? 'Création…' : 'Créer le transfert'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
