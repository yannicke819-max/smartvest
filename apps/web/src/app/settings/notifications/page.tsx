'use client';

import { useState } from 'react';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useUserProfile } from '@/hooks/use-portfolio';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';

const NOTIFICATION_OPTIONS = [
  {
    key: 'email_alerts',
    label: 'Alertes de portefeuille',
    description: 'Recevez un email quand une alerte se déclenche (seuil de perte, objectif atteint).',
  },
  {
    key: 'email_weekly_summary',
    label: 'Résumé hebdomadaire',
    description: 'Un récapitulatif de vos performances chaque lundi matin.',
  },
  {
    key: 'email_suggestions',
    label: 'Nouvelles suggestions Lisa',
    description: "Notification quand Lisa propose un scénario ou une analyse à valider.",
  },
] as const;

type NotifKey = (typeof NOTIFICATION_OPTIONS)[number]['key'];

export default function NotificationsPage() {
  const { data: profile, isLoading } = useUserProfile();
  const [prefs, setPrefs] = useState<Partial<Record<NotifKey, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  function getChecked(key: NotifKey): boolean {
    if (key in prefs) return !!prefs[key];
    const p = profile as Record<string, unknown> | null;
    if (p && key in p) return !!p[key];
    return true;
  }

  function toggle(key: NotifKey) {
    setPrefs((prev) => ({ ...prev, [key]: !getChecked(key) }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Non connecté');
      const update: Record<string, boolean> = {};
      for (const { key } of NOTIFICATION_OPTIONS) {
        update[key] = getChecked(key);
      }
      const { error: err } = await supabase
        .from('user_profiles')
        .update(update)
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
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choisissez quels emails vous souhaitez recevoir de SmartVest.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Préférences email</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {NOTIFICATION_OPTIONS.map(({ key, label, description }) => (
              <div key={key} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={getChecked(key)}
                  onClick={() => toggle(key)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                    getChecked(key) ? 'bg-primary' : 'bg-input'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg transition-transform ${
                      getChecked(key) ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Préférences enregistrées.</p>}

      <Button onClick={handleSave} disabled={saving || isLoading}>
        {saving ? 'Enregistrement…' : 'Enregistrer'}
      </Button>
    </div>
  );
}
