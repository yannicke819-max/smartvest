import type { MovementType } from '@/hooks/use-cash';

const LABEL: Record<MovementType, string> = {
  deposit: 'Dépôt',
  withdrawal: 'Retrait',
  transfer_in: 'Entrée',
  transfer_out: 'Sortie',
  settlement_credit: 'Règlement +',
  settlement_debit: 'Règlement −',
  reservation: 'Réservation',
  reservation_release: 'Libération',
  adjustment: 'Ajustement',
};

const STYLE: Record<MovementType, string> = {
  deposit: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  withdrawal: 'bg-orange-50 text-orange-700 border-orange-200',
  transfer_in: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  transfer_out: 'bg-orange-50 text-orange-700 border-orange-200',
  settlement_credit: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  settlement_debit: 'bg-orange-50 text-orange-700 border-orange-200',
  reservation: 'bg-sky-50 text-sky-700 border-sky-200',
  reservation_release: 'bg-slate-50 text-slate-600 border-slate-200',
  adjustment: 'bg-amber-50 text-amber-800 border-amber-200',
};

export function LedgerEntryBadge({ type }: { type: MovementType }) {
  const label = LABEL[type] ?? type;
  const style = STYLE[type] ?? 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${style}`}>
      {label}
    </span>
  );
}
