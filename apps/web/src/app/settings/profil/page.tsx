'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useUserProfile } from '@/hooks/use-portfolio';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { RiskBadge } from '@/components/ui/risk-badge';
import type { RiskProfile } from '@/components/ui/risk-badge';
import { HelpTip } from '@/components/ui/help-tip';
import { Skeleton } from '@/components/ui/skeleton';

const EXPERIENCE_OPTIONS = [
  { value: 'debutant', label: '🌱 Je débute', description: 'Nouveaux concepts à chaque étape.' },
  { value: 'basic', label: '💼 Familier', description: "Je connais actions, obligations, ETF." },
  { value: 'moderate', label: '📊 Occasionnel', description: 'J\'investis de temps en temps.' },
  { value: 'advanced', label: '⚙️ Expérimenté', description: 'Je lis bilans et analyses.' },
  { value: 'expert', label: '🎯 Expert', description: 'Dérivés, arbitrage, gestion active.' },
] as const;

export default function ProfilPage() {
  const { data: profile, isLoading } = useUserProfile();
  const [firstName, setFirstName] = useState('');
  const [experience, setExperience] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const router = useRouter();

  const currentFirstName = firstName || (profile?.first_name ?? '');
  const currentExperience = experience || (profile?.experience_level ?? '');

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Non connecté');
      const { error: err } = await supabase
        .from('user_profiles')
        .update({ first_name: currentFirstName, experience_level: currentExperience })
        .eq('id', user.id);
      if (err) throw new Error(err.message);
      await qc.invalidateQueries({ queryKey: ['user_profile'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Mon profil</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Informations personnelles et niveau d'expérience.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Prénom</CardTitle>
            </CardHeader>
            <CardContent>
              <input
                type="text"
                value={currentFirstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Votre prénom"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Adresse e-mail</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{profile?.email ?? '—'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                L'adresse e-mail ne peut pas être modifiée ici. Contactez le support.
              </p>
            </CardContent>
          </Card>

          {profile?.risk_profile && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  Profil de risque
                  <HelpTip
                    text="Votre profil oriente les simulations proposées (allocation, drawdown toléré). Il n'est jamais une recommandation d'investissement."
                    glossarySlug="profil-de-risque"
                    side="right"
                  />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RiskBadge
                  profile={profile.risk_profile as RiskProfile}
                  size="md"
                  showPhrase
                  showTip={false}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Défini lors de l'onboarding.{' '}
                  <a href="/onboarding" className="text-primary underline underline-offset-4">Refaire le questionnaire</a>
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                Niveau d'expérience
                <HelpTip
                  text="Cette information aide SmartVest à adapter ses explications. Elle ne change pas vos droits ni vos paramètres de simulation."
                  side="right"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {EXPERIENCE_OPTIONS.map(({ value, label, description }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setExperience(value)}
                  className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/30 ${
                    currentExperience === value ? 'border-primary bg-primary/5' : ''
                  }`}
                >
                  <div className={`h-3 w-3 shrink-0 rounded-full border-2 ${currentExperience === value ? 'border-primary bg-primary' : 'border-muted-foreground'}`} />
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="text-sm text-emerald-600">Profil mis à jour.</p>}

          <div className="flex gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
            <Button variant="outline" onClick={() => router.back()}>
              Annuler
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
