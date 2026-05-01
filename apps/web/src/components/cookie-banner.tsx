'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { type Route } from 'next';
import { Cookie } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readFeatureFlags } from '@/lib/feature-flags';

const CONSENT_KEY = 'smartvest_cookie_consent_v1';

export function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only show in SAFE_PUBLIC_MODE or REGULATED_MODE — not needed in PERSONAL_MODE.
    const flags = readFeatureFlags();
    if (flags.PERSONAL_MODE && !flags.SAFE_PUBLIC_MODE) return;

    try {
      if (!localStorage.getItem(CONSENT_KEY)) {
        setVisible(true);
      }
    } catch {
      // localStorage indisponible
    }
  }, []);

  function accept() {
    try {
      localStorage.setItem(CONSENT_KEY, 'accepted');
    } catch { /* noop */ }
    setVisible(false);
  }

  function refuse() {
    try {
      localStorage.setItem(CONSENT_KEY, 'refused');
    } catch { /* noop */ }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Gestion des cookies"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-xl rounded-xl border bg-background shadow-lg sm:left-auto sm:right-4 sm:w-96"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium">Cookies</p>
            <p className="mt-1 text-xs text-muted-foreground">
              SmartVest utilise uniquement des cookies essentiels (session, préférences d'interface).
              Aucun tracking publicitaire, aucun cookie tiers.{' '}
              <Link
                href={'/legal/cookies' as Route}
                className="text-primary hover:underline underline-offset-4"
              >
                En savoir plus
              </Link>
            </p>
          </div>
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={refuse}>
            Refuser
          </Button>
          <Button size="sm" onClick={accept}>
            Accepter
          </Button>
        </div>
      </div>
    </div>
  );
}
