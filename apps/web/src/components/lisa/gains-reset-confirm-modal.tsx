'use client';

/**
 * GainsResetConfirmModal — confirmation reset display-only avec "tape RESET".
 *
 * Reset display-only = met le marker à NOW dans lisa_session_configs.
 * Le compteur affiché ignore les trades antérieurs au marker. La DB reste
 * intacte, audit P&L global préservé. Action réversible via "Annuler reset".
 *
 * Pour les scopes mois et annual, on demande à l'utilisateur de taper "RESET"
 * (case insensitive) pour confirmer — friction volontaire sur action impactante.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

interface Props {
  scope: 'daily' | 'monthly' | 'annual';
  onConfirm: () => void;
  onCancel: () => void;
}

const SCOPE_INFO: Record<Props['scope'], { label: string; reverseImpact: string; dangerous: boolean }> = {
  daily: {
    label: 'jour',
    reverseImpact: 'Annulable à tout moment via "Annuler reset". DB intacte.',
    dangerous: false,
  },
  monthly: {
    label: 'mois',
    reverseImpact: 'Cascade : reset le mois ET le jour. Annulable. DB intacte.',
    dangerous: true,
  },
  annual: {
    label: 'année',
    reverseImpact: 'Cascade : reset année + mois + jour. Action IRRÉVERSIBLE côté UI (confirmation requise).',
    dangerous: true,
  },
};

export function GainsResetConfirmModal({ scope, onConfirm, onCancel }: Props) {
  const [mounted, setMounted] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState('');
  const info = SCOPE_INFO[scope];
  const needsTypedConfirm = info.dangerous;
  const canConfirm = !needsTypedConfirm || typedConfirm.toUpperCase().trim() === 'RESET';

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const content = (
    <>
      <button
        type="button"
        onClick={onCancel}
        className="fixed inset-0 bg-black/50 z-40"
        aria-label="Annuler"
      />
      <div
        className="fixed z-50 bg-card border shadow-lg
                   md:rounded-lg md:p-6 md:max-w-sm md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2
                   max-md:left-0 max-md:right-0 max-md:bottom-0 max-md:rounded-t-2xl max-md:p-4 max-md:pb-8"
      >
        <h3 className="text-base font-semibold mb-2">
          {info.dangerous ? '⚠️' : '🔄'} Reset {info.label}
        </h3>

        <p className="text-sm text-muted-foreground mb-3">
          Cette action <strong>n&apos;efface PAS les trades en base de données</strong>.
          Elle pose un marker timestamp à partir duquel le compteur {info.label} affiché
          ignore les trades antérieurs.
        </p>

        <div className="rounded-md bg-muted/50 p-3 text-[11px] mb-3">
          {info.reverseImpact}
        </div>

        {needsTypedConfirm && (
          <div className="space-y-1.5 mb-3">
            <label className="text-xs font-medium">
              Tape <code className="bg-muted px-1.5 py-0.5 rounded text-[11px]">RESET</code> pour confirmer :
            </label>
            <input
              type="text"
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              className="w-full rounded border px-2 py-1.5 text-sm bg-background"
              autoFocus
              placeholder="RESET"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Annuler
          </Button>
          <Button
            variant={info.dangerous ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            Reset {info.label}
          </Button>
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
