import { Coins } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface FrictionItem {
  label: string;
  amount: string;
  hint?: string;
}

interface Props {
  currency: string;
  items: FrictionItem[];
  period?: string;
}

export function CostFrictionCard({ currency, items, period = '30 derniers jours' }: Props) {
  const total = items.reduce((sum, i) => sum + parseFloat(i.amount || '0'), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Frictions d'intermédiation
          </CardTitle>
          <CardDescription>{period}</CardDescription>
        </div>
        <Coins className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-2xl font-semibold">
          {total.toFixed(2)} {currency}
        </div>
        <div className="space-y-1.5">
          {items.map((item) => (
            <div key={item.label} className="flex justify-between text-xs">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-medium">
                {parseFloat(item.amount).toFixed(2)} {currency}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Frais broker + spreads + slippage + coûts FX. Rendre ces frictions visibles
          est la première étape pour les optimiser.
        </p>
      </CardContent>
    </Card>
  );
}
