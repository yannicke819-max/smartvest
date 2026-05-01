'use client';

import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export type ExperienceTier = 'debutant' | 'initie' | 'expert';

interface ExperienceLevelState {
  level: string | null;
  tier: ExperienceTier;
  isLoading: boolean;
}

const TIER_MAP: Record<string, ExperienceTier> = {
  none: 'debutant',
  basic: 'debutant',
  moderate: 'initie',
  advanced: 'expert',
  expert: 'expert',
};

export function useExperienceLevel(): ExperienceLevelState {
  const [level, setLevel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = createSupabaseBrowserClient();
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (cancelled || !user) { setIsLoading(false); return; }
        supabase
          .from('user_onboarding')
          .select('level')
          .eq('user_id', user.id)
          .single()
          .then(({ data }) => {
            if (!cancelled) {
              setLevel(data?.level ?? null);
              setIsLoading(false);
            }
          });
      });
    } catch {
      setIsLoading(false);
    }
    return () => { cancelled = true; };
  }, []);

  // Falls back to 'expert' tier when not loaded → show everything, hide nothing.
  const tier: ExperienceTier = level ? (TIER_MAP[level] ?? 'expert') : 'expert';

  return { level, tier, isLoading };
}
