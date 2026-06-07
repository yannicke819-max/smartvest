'use client';

/**
 * LisaConfigPanel — B.3, Config LISA simplifiée (mobile-first).
 *
 * Sections :
 *   1. Kill-switch (rendu uniquement si armé) → bouton "Désarmer" + confirm
 *   2. Capital initial + intérêts composés
 *   3. Daily digest email
 *   4. Lessons management (toggle is_active, search, filtre actives/inactives)
 *
 * "Secrets read-only" déféré (env vars Fly non exposables côté front sans
 * endpoint dédié).
 */

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useLisaConfig, useUpsertLisaConfig } from '@/hooks/use-lisa';
import {
  useScannerLessons,
  useToggleScannerLesson,
  useResetKillSwitch,
} from '@/hooks/use-scanner-lessons';
import { usePushSubscription } from '@/hooks/use-push-subscription';

interface Props {
  portfolioId: string;
  // 07/06 — filtre les lessons affichées par préfixe de scope. En mode oversold,
  // on passe 'oversold' : le corpus historique (251 lessons gainers/trader, scopes
  // trader_agent_only / asia_only / eu_only / us_only…) disparaît, et SEULES les
  // nouvelles lessons oversold (scope 'oversold*') s'afficheront à mesure qu'elles
  // sont générées. undefined = pas de filtre (tous les scopes, modes LLM).
  lessonsScopePrefix?: string;
}

export function LisaConfigPanel({ portfolioId, lessonsScopePrefix }: Props) {
  const configQuery = useLisaConfig(portfolioId);
  const upsert = useUpsertLisaConfig(portfolioId);
  const resetKill = useResetKillSwitch(portfolioId);

  const config = configQuery.data as Record<string, unknown> | null;
  const killSwitchActive = Boolean(config?.kill_switch_active);
  const initialCapital = Number(config?.lisa_initial_capital_usd ?? 10000);
  const compoundEnabled = Boolean(config?.lisa_compound_pnl_enabled ?? true);
  const digestEnabled = Boolean(config?.lisa_daily_digest_enabled ?? true);
  const email = String(config?.lisa_notification_email ?? '');

  // Locaux éditables (synchronisés à la valeur DB en initial)
  const [draftCapital, setDraftCapital] = useState<string>('');
  const [draftEmail, setDraftEmail] = useState<string>('');

  const effCapital = draftCapital === '' ? initialCapital : Number(draftCapital);
  const effEmail = draftEmail === '' ? email : draftEmail;

  const saveCapital = async () => {
    await upsert.mutateAsync({
      lisa_initial_capital_usd: effCapital,
    } as Record<string, unknown>);
    setDraftCapital('');
  };

  const toggleCompound = async (v: boolean) => {
    await upsert.mutateAsync({ lisa_compound_pnl_enabled: v } as Record<string, unknown>);
  };

  const toggleDigest = async (v: boolean) => {
    await upsert.mutateAsync({ lisa_daily_digest_enabled: v } as Record<string, unknown>);
  };

  const saveEmail = async () => {
    await upsert.mutateAsync({
      lisa_notification_email: effEmail.trim() || null,
    } as Record<string, unknown>);
    setDraftEmail('');
  };

  const onResetKill = async () => {
    if (!window.confirm('Désarmer le kill-switch anti-spirale ? TRADER reprendra dès le prochain cycle.')) return;
    await resetKill.mutateAsync();
  };

  if (configQuery.isLoading) {
    return (
      <Card className="p-4">
        <div className="animate-pulse h-32 bg-muted rounded" />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-3">⚙️ Configuration LISA</h3>

      {/* 1. Kill-switch (conditional) */}
      {killSwitchActive && (
        <div className="mb-4 rounded-lg border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/30 p-3">
          <div className="flex items-start gap-2 mb-2">
            <span className="text-lg">🛑</span>
            <div className="flex-1">
              <div className="text-sm font-semibold text-rose-700 dark:text-rose-300">
                Kill-switch anti-spirale armé
              </div>
              <div className="text-xs text-rose-700/80 dark:text-rose-300/80 mt-0.5">
                TRADER est suspendu. Désarme pour reprendre les cycles.
              </div>
            </div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={onResetKill}
            disabled={resetKill.isPending}
            className="w-full sm:w-auto"
          >
            {resetKill.isPending ? 'Désarmement…' : 'Désarmer kill-switch'}
          </Button>
        </div>
      )}

      {/* 2. Capital initial + compound */}
      <div className="mb-4 pb-4 border-b">
        <div className="text-xs font-semibold mb-2">💰 Capital</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-muted-foreground">Capital initial $</label>
            <div className="flex gap-1.5 mt-1">
              <input
                type="number"
                value={draftCapital !== '' ? draftCapital : initialCapital}
                onChange={(e) => setDraftCapital(e.target.value)}
                className="flex-1 rounded border px-2 py-1.5 text-sm bg-background tabular-nums"
                min={100}
                step={100}
              />
              <Button
                size="sm"
                onClick={saveCapital}
                disabled={upsert.isPending || draftCapital === '' || Number(draftCapital) === initialCapital}
              >
                OK
              </Button>
            </div>
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground">Intérêts composés</label>
            <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={compoundEnabled}
                onChange={(e) => toggleCompound(e.target.checked)}
                disabled={upsert.isPending}
                className="accent-primary h-4 w-4"
              />
              <span className="text-xs">
                {compoundEnabled
                  ? 'Activés (capital évolue avec les gains)'
                  : 'Désactivés (capital fixe = initial)'}
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* 3. Daily digest */}
      <div className="mb-4 pb-4 border-b">
        <div className="text-xs font-semibold mb-2">📧 Daily Digest</div>
        <label className="flex items-center gap-2 mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={digestEnabled}
            onChange={(e) => toggleDigest(e.target.checked)}
            disabled={upsert.isPending}
            className="accent-primary h-4 w-4"
          />
          <span className="text-xs">
            Email récapitulatif chaque jour à 09:00 UTC
          </span>
        </label>
        <div className="flex gap-1.5">
          <input
            type="email"
            placeholder="email@example.com"
            value={draftEmail !== '' ? draftEmail : email}
            onChange={(e) => setDraftEmail(e.target.value)}
            className="flex-1 rounded border px-2 py-1.5 text-sm bg-background"
          />
          <Button
            size="sm"
            onClick={saveEmail}
            disabled={upsert.isPending || draftEmail === '' || draftEmail.trim() === email}
          >
            OK
          </Button>
        </div>
      </div>

      {/* 4. Push notifications */}
      <PushNotificationsSection />

      {/* 5. Lessons management — filtré par scope (oversold = nouvelles lessons only) */}
      <LessonsManagementSection scopePrefix={lessonsScopePrefix} />
    </Card>
  );
}

function PushNotificationsSection() {
  const { status, error, subscribe, unsubscribe } = usePushSubscription();
  return (
    <div className="mb-4 pb-4 border-b">
      <div className="text-xs font-semibold mb-2">🔔 Notifications push</div>
      {status === 'loading' && (
        <div className="text-xs text-muted-foreground">Détection…</div>
      )}
      {status === 'unsupported' && (
        <div className="text-xs text-muted-foreground">
          Push API non supportée sur ce navigateur.
        </div>
      )}
      {status === 'permission-denied' && (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          Permission notifications refusée. Active-la dans les réglages navigateur puis recharge.
        </div>
      )}
      {status === 'not-subscribed' && (
        <Button size="sm" onClick={subscribe}>
          Activer notifications push
        </Button>
      )}
      {status === 'subscribed' && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ Actives sur cet appareil</span>
          <Button size="sm" variant="outline" onClick={unsubscribe}>
            Désactiver
          </Button>
        </div>
      )}
      {error && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">
          {error}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-1">
        Notifications kill-switch + propositions Strategy Coach. Trigger-only (le contenu est rafraîchi à l'ouverture).
      </p>
    </div>
  );
}

function LessonsManagementSection({ scopePrefix }: { scopePrefix?: string }) {
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const lessonsQuery = useScannerLessons({
    active: activeFilter === 'active' ? true : activeFilter === 'inactive' ? false : null,
    search: search || undefined,
    limit: 500,
  });
  const toggle = useToggleScannerLesson();

  // 07/06 — Filtre client par préfixe de scope. En oversold (scopePrefix='oversold'),
  // on n'affiche QUE les lessons oversold : le corpus gainers/trader (scopes
  // trader_agent_only/asia_only/eu_only/us_only/…) disparaît de la vue. Les
  // nouvelles lessons oversold (scope 'oversold*') apparaîtront ici à mesure
  // qu'elles sont générées. (Le pipeline oversold ne LIT pas ces lessons ; cette
  // section sert à les inspecter/désactiver à la main.)
  const rows = useMemo(() => {
    const all = lessonsQuery.data ?? [];
    if (!scopePrefix) return all;
    return all.filter((r) => (r.scope ?? '').toLowerCase().startsWith(scopePrefix.toLowerCase()));
  }, [lessonsQuery.data, scopePrefix]);

  const counts = useMemo(
    () => ({ total: rows.length, active: rows.filter((r) => r.is_active).length }),
    [rows],
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-xs font-semibold">📚 Lessons ({counts.active}/{counts.total} actives)</div>
      </div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <input
          type="text"
          placeholder="Search kind / text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[160px] rounded border px-2 py-1.5 text-xs bg-background"
        />
        <select
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}
          className="rounded border px-2 py-1.5 text-xs bg-background"
        >
          <option value="all">Toutes</option>
          <option value="active">Actives</option>
          <option value="inactive">Inactives</option>
        </select>
      </div>

      {lessonsQuery.isLoading && (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse h-10 bg-muted rounded" />
          ))}
        </div>
      )}

      {!lessonsQuery.isLoading && rows.length === 0 && (
        <div className="text-xs text-muted-foreground py-4 text-center">
          {scopePrefix
            ? `Aucune lesson « ${scopePrefix} » pour l'instant — les nouvelles lessons de ce mode apparaîtront ici (l'ancien corpus gainers/TRADER est masqué).`
            : 'Aucune lesson.'}
        </div>
      )}

      {!lessonsQuery.isLoading && rows.length > 0 && (
        <div className="space-y-1 max-h-[420px] overflow-y-auto">
          {rows.map((l) => (
            <div
              key={l.id}
              className={`rounded border p-2 flex items-start gap-2 ${
                l.is_active ? 'bg-card' : 'bg-muted/30 opacity-70'
              }`}
            >
              <input
                type="checkbox"
                checked={l.is_active}
                onChange={(e) => toggle.mutate({ id: l.id, isActive: e.target.checked })}
                disabled={toggle.isPending}
                className="accent-primary h-4 w-4 mt-0.5"
                aria-label={`Toggle ${l.lesson_kind}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <code className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                    {l.lesson_kind}
                  </code>
                  <span className="text-[10px] text-muted-foreground">{l.scope}</span>
                  {l.confidence !== null && (
                    <span className="text-[10px] text-muted-foreground">
                      conf {l.confidence.toFixed(2)}
                    </span>
                  )}
                  {l.sample_size !== null && (
                    <span className="text-[10px] text-muted-foreground">
                      n={l.sample_size}
                    </span>
                  )}
                </div>
                <div className="text-[11px] mt-1 line-clamp-2">{l.lesson_text}</div>
                {l.macro_condition && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Cond: <code>{l.macro_condition}</code>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
