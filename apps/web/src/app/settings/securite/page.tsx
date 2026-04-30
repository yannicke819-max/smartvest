'use client';

import { useState } from 'react';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { ShieldCheck } from 'lucide-react';

export default function SecuritePage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChangePassword() {
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Le nouveau mot de passe doit contenir au moins 8 caractères.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.updateUser({ password: newPassword });
      if (err) throw new Error(err.message);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOutAll() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut({ scope: 'global' });
    window.location.href = '/';
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Sécurité</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mot de passe et gestion des sessions.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            Changer de mot de passe
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Mot de passe actuel</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Nouveau mot de passe</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="8 caractères minimum"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Confirmer le nouveau mot de passe</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Répétez le mot de passe"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="text-sm text-emerald-600">Mot de passe mis à jour.</p>}

          <Button onClick={handleChangePassword} disabled={saving || !newPassword}>
            {saving ? 'Mise à jour…' : 'Mettre à jour'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Déconnectez-vous de toutes les sessions actives sur tous les appareils.
          </p>
          <Button variant="outline" onClick={handleSignOutAll}>
            Se déconnecter partout
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
