import { ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { HelpTip } from '@/components/ui/help-tip';
import { RiskBadge } from '@/components/ui/risk-badge';

interface Props {
  profile: string | null | undefined;
  loading?: boolean;
}

export function RiskProfileCard({ profile, loading }: Props) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          Profil de simulation
          <HelpTip
            text="Votre niveau de tolérance au risque déclaré. Module les paramètres des simulations Lisa (stops, taille des positions, fréquence d'analyse)."
            glossarySlug="profil-de-risque"
            side="right"
          />
        </CardTitle>
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : profile ? (
          <>
            <RiskBadge profile={profile} size="md" showPhrase showTip={false} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Module vos simulations. Révisable dans les paramètres.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Non défini</p>
        )}
      </CardContent>
    </Card>
  );
}
