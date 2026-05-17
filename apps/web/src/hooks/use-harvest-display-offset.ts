'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * PR #347 — offset client localStorage pour rebaser l'affichage des 4 zones
 * de gains du tracker DAILY_HARVEST (jour, mois, année + panel objectif) sans
 * toucher au backend ni à la DB.
 *
 * Cas d'usage : la position bug SEE.LSE (exit_price=0, -$1574 fictif 14/05/2026)
 * pollue les agrégats. L'utilisateur veut une remise à zéro visuelle persistante
 * sans déclencher resetSimulation (DELETE destructif 8 tables interdit ici).
 *
 * - Scope clé localStorage : par `portfolioId` → changer de portfolio
 *   n'hérite pas de l'offset.
 * - Sync inter-onglets via event `storage`.
 * - SSR-safe : retourne `null` côté serveur.
 */

export interface HarvestOffset {
  realizedToday: number;
  securedToday: number;
  dailyRealized: number;
  dailySecured: number;
  mtdRealized: number;
  mtdSecured: number;
  ytdRealized: number;
  ytdSecured: number;
  rebasedAt: string; // ISO timestamp
}

const STORAGE_KEY_PREFIX = 'smartvest:harvest-display-offset:';

function readOffset(portfolioId: string): HarvestOffset | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + portfolioId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HarvestOffset;
    const numericKeys: Array<keyof HarvestOffset> = [
      'realizedToday',
      'securedToday',
      'dailyRealized',
      'dailySecured',
      'mtdRealized',
      'mtdSecured',
      'ytdRealized',
      'ytdSecured',
    ];
    for (const k of numericKeys) {
      const v = parsed[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    }
    if (!parsed.rebasedAt || Number.isNaN(new Date(parsed.rebasedAt).getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function useHarvestDisplayOffset(portfolioId: string) {
  const [offset, setOffset] = useState<HarvestOffset | null>(null);

  useEffect(() => {
    setOffset(readOffset(portfolioId));
  }, [portfolioId]);

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY_PREFIX + portfolioId) {
        setOffset(readOffset(portfolioId));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [portfolioId]);

  const setRebase = useCallback(
    (next: Omit<HarvestOffset, 'rebasedAt'>) => {
      const full: HarvestOffset = { ...next, rebasedAt: new Date().toISOString() };
      window.localStorage.setItem(STORAGE_KEY_PREFIX + portfolioId, JSON.stringify(full));
      setOffset(full);
    },
    [portfolioId],
  );

  const clearRebase = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY_PREFIX + portfolioId);
    setOffset(null);
  }, [portfolioId]);

  return { offset, setRebase, clearRebase };
}
