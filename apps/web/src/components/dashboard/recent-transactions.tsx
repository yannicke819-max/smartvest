import { ArrowDownLeft, ArrowUpRight, Repeat } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/states/empty-state';

interface Transaction {
  id: string;
  type: string;
  trade_date: string;
  quantity: string | null;
  unit_price: string | null;
  currency: string;
  assets: { ticker: string; name: string } | null;
}

const TYPE_META: Record<string, { label: string; icon: React.ElementType; positive: boolean }> = {
  buy: { label: 'Achat', icon: ArrowDownLeft, positive: false },
  sell: { label: 'Vente', icon: ArrowUpRight, positive: true },
  dividend: { label: 'Dividende', icon: ArrowUpRight, positive: true },
  transfer_in: { label: 'Dépôt', icon: ArrowDownLeft, positive: false },
  transfer_out: { label: 'Retrait', icon: ArrowUpRight, positive: true },
  fee: { label: 'Frais', icon: Repeat, positive: false },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: '2-digit',
  });
}

interface Props {
  transactions: Transaction[];
  loading: boolean;
}

export function RecentTransactions({ transactions, loading }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transactions récentes</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-3.5 w-16" />
              </div>
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <EmptyState
            title="Aucune transaction"
            description="Importez ou saisissez vos transactions pour voir l'historique."
          />
        ) : (
          <div className="divide-y">
            {transactions.map((tx) => {
              const meta = TYPE_META[tx.type] ?? { label: tx.type, icon: Repeat, positive: false };
              const Icon = meta.icon;
              const amount =
                tx.quantity && tx.unit_price
                  ? `${(parseFloat(tx.quantity) * parseFloat(tx.unit_price)).toFixed(2)} ${tx.currency}`
                  : tx.currency;
              return (
                <div key={tx.id} className="flex items-center gap-3 py-3">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-sm ${
                      meta.positive
                        ? 'bg-accent/15 text-accent'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {meta.label}
                      {tx.assets ? ` · ${tx.assets.ticker}` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatDate(tx.trade_date)}</p>
                  </div>
                  <p className="whitespace-nowrap text-sm font-medium">{amount}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
