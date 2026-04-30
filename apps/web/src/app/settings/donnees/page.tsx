'use client';

import { useState } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { Download, Trash2 } from 'lucide-react';

export default function DonneesPage() {
  const [exporting, setExporting] = useState(false);
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Non connecté');
      const res = await fetch('/api/me/export', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smartvest-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleteStep('deleting');
    setError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Non connecté');
      const res = await fetch('/api/me', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      await supabase.auth.signOut();
      router.push('/');
    } catch (e) {
      setError((e as Error).message);
      setDeleteStep('confirm');
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackButton />

      <div>
        <h1 className="text-xl font-semibold">Mes données</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Exportez ou supprimez vos données personnelles (RGPD).
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Download className="h-4 w-4" />
            Exporter mes données
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Téléchargez une copie de toutes vos données : profil, portefeuilles,
            positions, transactions et paramètres. Format JSON.
          </p>
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Export en cours…' : 'Télécharger mes données'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Conformément au{' '}
            <Link href={'/legal/confidentialite' as Route} className="text-primary underline underline-offset-4">
              droit à la portabilité (RGPD)
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-destructive">
            <Trash2 className="h-4 w-4" />
            Supprimer mon compte
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Supprime définitivement votre compte et toutes vos données sous 30 jours.
            Cette action est irréversible.
          </p>

          {deleteStep === 'idle' && (
            <Button
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteStep('confirm')}
            >
              Supprimer mon compte
            </Button>
          )}

          {deleteStep === 'confirm' && (
            <div className="space-y-3 rounded-lg border border-destructive/30 p-4">
              <p className="text-sm font-medium text-destructive">
                Confirmation requise
              </p>
              <p className="text-xs text-muted-foreground">
                Tapez <strong>SUPPRIMER</strong> pour confirmer la suppression
                définitive de votre compte et de toutes vos données.
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="SUPPRIMER"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-destructive"
                aria-label="Tapez SUPPRIMER pour confirmer"
              />
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccount}
                  disabled={confirmText !== 'SUPPRIMER'}
                >
                  Confirmer la suppression
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setDeleteStep('idle'); setConfirmText(''); }}
                >
                  Annuler
                </Button>
              </div>
            </div>
          )}

          {deleteStep === 'deleting' && (
            <p className="text-sm text-muted-foreground">Suppression en cours…</p>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
