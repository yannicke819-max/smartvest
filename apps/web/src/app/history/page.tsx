'use client';

import Link from 'next/link';
import { ArrowLeftRight, BookOpen, History } from 'lucide-react';
import { BackButton } from '@/components/ui/back-button';

const SECTIONS = [
  {
    href: '/cash/ledger',
    icon: BookOpen,
    label: 'Livre de caisse',
    description: 'Mouvements de trésorerie, dépôts et retraits.',
  },
  {
    href: '/funding',
    icon: ArrowLeftRight,
    label: 'Transferts de fonds',
    description: 'Historique des virements entre sources et destinations.',
  },
] as const;

export default function HistoryPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <BackButton />
      <div>
        <h1 className="text-xl font-semibold">Mes opérations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Historique de vos mouvements de trésorerie et transferts.
        </p>
      </div>

      <div className="rounded-lg border divide-y">
        {SECTIONS.map(({ href, icon: Icon, label, description }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/30"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            <History className="h-4 w-4 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
