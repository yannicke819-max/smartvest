import { ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface Props {
  profile: string | null | undefined;
  loading?: boolean;
}

const LABELS: Record<string, { label: string; color: string; emoji: string }> = {
  prudent: { label: 'Prudent', color: 'text-accent', emoji: '🛡' },
  equilibre: { label: 'Équilibré', color: 'text-primary', emoji: '⚖' },
  dynamique: { label: 'Dynamique', color: 'text-warning', emoji: '📈' },
  offensif: { label: 'Offensif', color: 'text-destructive', emoji: '🚀' },
  sur_mesure: { label: 'Sur-mesure', color: 'text-muted-foreground', emoji: '✏' },
};

export function RiskProfileCard({ profile, loading }: Props) {
  const meta = profile ? LABELS[profile] : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Profil de simulation</CardTitle>
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : meta ? (
          <>
            <div className={`text-2xl font-semibold ${meta.color}`}>
              {meta.emoji} {meta.label}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Module vos templates de simulation. Révisable dans les paramètres.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Non défini</p>
        )}
      </CardContent>
    </Card>
  );
}
