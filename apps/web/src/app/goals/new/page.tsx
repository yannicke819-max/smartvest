'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateGoal } from '@/hooks/use-goals';
import { usePortfolios } from '@/hooks/use-portfolio';
import { Button } from '@/components/ui/button';
import { BackButton } from '@/components/ui/back-button';

const GOAL_TYPES = [
  { value: 'retirement', label: 'Retraite' },
  { value: 'real_estate', label: 'Immobilier' },
  { value: 'education', label: 'Éducation' },
  { value: 'emergency_fund', label: 'Épargne de précaution' },
  { value: 'travel', label: 'Voyage' },
  { value: 'business', label: 'Projet entrepreneurial' },
  { value: 'other', label: 'Autre' },
];

export default function NewGoalPage() {
  const router = useRouter();
  const portfoliosQuery = usePortfolios();
  const createGoal = useCreateGoal();

  const [form, setForm] = useState({
    name: '',
    type: 'other',
    description: '',
    targetAmount: '',
    currency: 'EUR',
    currentAmount: '0',
    monthlyContribution: '0',
    horizonMonths: '60',
    targetDate: '',
  });

  const portfolioId = portfoliosQuery.data?.[0]?.id ?? '';

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data = await createGoal.mutateAsync({
      portfolioId,
      type: form.type,
      name: form.name,
      description: form.description || undefined,
      targetAmount: form.targetAmount,
      currency: form.currency,
      currentAmount: form.currentAmount || '0',
      monthlyContribution: form.monthlyContribution || '0',
      horizonMonths: parseInt(form.horizonMonths, 10),
      targetDate: form.targetDate || undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.push(`/goals/${(data as any).id}`);
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <BackButton />
        <div>
          <h1 className="text-xl font-semibold">Nouvel objectif</h1>
          <p className="text-sm text-muted-foreground">
            Définissez votre projet d'investissement.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border p-5">
        <div className="space-y-1">
          <label className="text-sm font-medium">Nom de l'objectif</label>
          <input
            name="name"
            value={form.name}
            onChange={handleChange}
            required
            placeholder="Ex : Retraite anticipée à 55 ans"
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Type de projet</label>
          <select
            name="type"
            value={form.type}
            onChange={handleChange}
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          >
            {GOAL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Montant cible</label>
            <input
              name="targetAmount"
              value={form.targetAmount}
              onChange={handleChange}
              required
              type="number"
              min="0"
              step="0.01"
              placeholder="100000"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Devise</label>
            <input
              name="currency"
              value={form.currency}
              onChange={handleChange}
              maxLength={3}
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Capital actuel</label>
            <input
              name="currentAmount"
              value={form.currentAmount}
              onChange={handleChange}
              type="number"
              min="0"
              step="0.01"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Versement mensuel</label>
            <input
              name="monthlyContribution"
              value={form.monthlyContribution}
              onChange={handleChange}
              type="number"
              min="0"
              step="0.01"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Horizon (mois)</label>
            <input
              name="horizonMonths"
              value={form.horizonMonths}
              onChange={handleChange}
              type="number"
              min="1"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Date cible (optionnel)</label>
            <input
              name="targetDate"
              value={form.targetDate}
              onChange={handleChange}
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Description (optionnel)</label>
          <textarea
            name="description"
            value={form.description}
            onChange={handleChange}
            rows={3}
            placeholder="Contexte, motivations, contraintes spécifiques…"
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {createGoal.isError && (
          <p className="text-sm text-red-500">{(createGoal.error as Error).message}</p>
        )}

        <Button type="submit" className="w-full" disabled={createGoal.isPending || !portfolioId}>
          {createGoal.isPending ? 'Création…' : 'Créer l\'objectif'}
        </Button>
      </form>
    </div>
  );
}
