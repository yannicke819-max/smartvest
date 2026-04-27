'use client';

import { useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import {
  useDailyHarvest,
  useUpdateDailyHarvestConfig,
  type DailyHarvestConfig,
  type ProfitSweepMode,
} from '@/hooks/use-daily-harvest';

const DEFAULT_CONFIG: DailyHarvestConfig = {
  dailyTargetAmountUsd: 50,
  dailyTargetPercent: null,
  workingCapitalBaseUsd: 10000,
  profitSweepMode: 'PER_TRADE',
  stopTradingWhenTargetHit: true,
  allowReentryAfterTargetHit: false,
  maxLossPerDayUsd: 200,
  maxTradesPerDay: 20,
  sessionStartTime: '09:00',
  sessionEndTime: '22:00',
  timezone: 'Europe/Paris',
  cooldownMinutesAfterClose: 5,
  takeProfitAbsolutePct: 2.5,
};

export function DailyHarvestPanel({ portfolioId }: { portfolioId: string }) {
  const query = useDailyHarvest(portfolioId);
  const updateMut = useUpdateDailyHarvestConfig(portfolioId);

  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState<DailyHarvestConfig>(DEFAULT_CONFIG);
  const [targetMode, setTargetMode] = useState<'amount' | 'percent'>('amount');
  const [saved, setSaved] = useState(false);

  // Sync depuis le serveur quand la query résout
  useEffect(() => {
    if (!query.data) return;
    if (query.data.mode === 'DAILY_HARVEST' && query.data.config) {
      setEnabled(true);
      setConfig(query.data.config);
      setTargetMode(query.data.config.dailyTargetPercent != null ? 'percent' : 'amount');
    } else {
      setEnabled(false);
    }
  }, [query.data]);

  const handleSave = async () => {
    try {
      // Nettoie la cible selon le mode choisi
      const cleanConfig: DailyHarvestConfig = {
        ...config,
        dailyTargetAmountUsd: targetMode === 'amount' ? config.dailyTargetAmountUsd : null,
        dailyTargetPercent: targetMode === 'percent' ? config.dailyTargetPercent : null,
      };

      await updateMut.mutateAsync({
        mode: enabled ? 'DAILY_HARVEST' : 'NONE',
        ...(enabled ? { config: cleanConfig } : {}),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error('Save failed:', e);
    }
  };

  return (
    <div className="rounded-lg border p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            Daily Harvest — discipline de profit-taking journalier
          </h2>
          <p className="mt-1 text-xs text-muted-foreground max-w-2xl">
            Capital de travail fixe + objectif jour + sweep automatique des gains vers un vault séparé.
            La discipline empêche de redonner au marché ce qui a été gagné. Reset automatique chaque
            jour à l&apos;heure de session configurée.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="font-medium">{enabled ? 'Activé' : 'Désactivé'}</span>
        </label>
      </div>

      {enabled && (
        <div className="space-y-4 pt-3 border-t">
          {/* Cible journalière */}
          <div>
            <label className="text-xs font-medium mb-1.5 block">Objectif journalier</label>
            <div className="flex items-center gap-3">
              <select
                value={targetMode}
                onChange={(e) => setTargetMode(e.target.value as 'amount' | 'percent')}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="amount">Montant fixe (USD)</option>
                <option value="percent">% du working capital</option>
              </select>
              {targetMode === 'amount' ? (
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={config.dailyTargetAmountUsd ?? 0}
                  onChange={(e) =>
                    setConfig({ ...config, dailyTargetAmountUsd: parseFloat(e.target.value) || 0 })
                  }
                  className="h-8 w-32 rounded-md border bg-background px-2 text-xs"
                  placeholder="50"
                />
              ) : (
                <input
                  type="number"
                  min="0.01"
                  max="50"
                  step="0.01"
                  value={config.dailyTargetPercent ?? 0}
                  onChange={(e) =>
                    setConfig({ ...config, dailyTargetPercent: parseFloat(e.target.value) || 0 })
                  }
                  className="h-8 w-32 rounded-md border bg-background px-2 text-xs"
                  placeholder="0.5"
                />
              )}
              <span className="text-xs text-muted-foreground">
                {targetMode === 'amount' ? 'USD' : '%'}
              </span>
            </div>
          </div>

          {/* Working capital + caps */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Working capital de référence (USD)">
              <input
                type="number"
                min="100"
                step="100"
                value={config.workingCapitalBaseUsd}
                onChange={(e) =>
                  setConfig({ ...config, workingCapitalBaseUsd: parseFloat(e.target.value) || 0 })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </Field>
            <Field label="Perte max / jour (USD)">
              <input
                type="number"
                min="0"
                step="10"
                value={config.maxLossPerDayUsd ?? ''}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    maxLossPerDayUsd: e.target.value ? parseFloat(e.target.value) : undefined,
                  })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                placeholder="200"
              />
            </Field>
            <Field label="Trades max / jour">
              <input
                type="number"
                min="1"
                step="1"
                value={config.maxTradesPerDay ?? ''}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    maxTradesPerDay: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                placeholder="20"
              />
            </Field>
          </div>

          {/* Mode sweep + comportement target hit */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Mode de sweep">
              <select
                value={config.profitSweepMode}
                onChange={(e) =>
                  setConfig({ ...config, profitSweepMode: e.target.value as ProfitSweepMode })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              >
                <option value="PER_TRADE">PER_TRADE — sweep à chaque close gagnant</option>
                <option value="END_OF_DAY">END_OF_DAY — sweep en fin de session</option>
              </select>
            </Field>
            <Field label="Cooldown après close (min)">
              <input
                type="number"
                min="0"
                max="60"
                step="1"
                value={config.cooldownMinutesAfterClose}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    cooldownMinutesAfterClose: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </Field>
            <Field label="Take-profit absolu (%)">
              <input
                type="number"
                min="0.5"
                max="20"
                step="0.1"
                value={config.takeProfitAbsolutePct ?? 2.5}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    takeProfitAbsolutePct: parseFloat(e.target.value) || 2.5,
                  })
                }
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </Field>
          </div>
          <p className="text-[10px] text-muted-foreground italic -mt-1">
            Take-profit absolu = ferme la position dès que P&amp;L latent ≥ ce seuil. Garantit la matérialisation
            des gains avant qu&apos;ils s&apos;évaporent. 2.5% = couvre 12× les coûts en simulation paper. Plus haut = laisse courir mais risque retournement.
          </p>

          {/* Plage horaire */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Début session">
              <input
                type="time"
                value={config.sessionStartTime}
                onChange={(e) => setConfig({ ...config, sessionStartTime: e.target.value })}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </Field>
            <Field label="Fin session">
              <input
                type="time"
                value={config.sessionEndTime}
                onChange={(e) => setConfig({ ...config, sessionEndTime: e.target.value })}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              />
            </Field>
            <Field label="Timezone">
              <select
                value={config.timezone}
                onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              >
                <option value="Europe/Paris">Europe/Paris</option>
                <option value="Europe/London">Europe/London</option>
                <option value="America/New_York">America/New_York</option>
                <option value="UTC">UTC</option>
              </select>
            </Field>
          </div>

          {/* Comportement target hit */}
          <div className="space-y-2 pt-2 border-t">
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={config.stopTradingWhenTargetHit}
                onChange={(e) =>
                  setConfig({ ...config, stopTradingWhenTargetHit: e.target.checked })
                }
                className="mt-0.5"
              />
              <span>
                <strong>Arrêter le trading si target atteint</strong>{' '}
                <span className="text-muted-foreground">
                  — recommandé pour la discipline. Lisa renvoie theses=[] et le mécanique skip
                  toutes nouvelles ouvertures jusqu&apos;au reset journalier.
                </span>
              </span>
            </label>
            {!config.stopTradingWhenTargetHit && (
              <label className="flex items-start gap-2 text-xs cursor-pointer ml-6">
                <input
                  type="checkbox"
                  checked={config.allowReentryAfterTargetHit}
                  onChange={(e) =>
                    setConfig({ ...config, allowReentryAfterTargetHit: e.target.checked })
                  }
                  className="mt-0.5"
                />
                <span>
                  <strong>Autoriser ré-entrée après target hit</strong>{' '}
                  <span className="text-muted-foreground">
                    — mode scalping continu. À utiliser avec un cooldown élevé.
                  </span>
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 pt-3 border-t">
        <button
          type="button"
          onClick={handleSave}
          disabled={updateMut.isPending}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {updateMut.isPending ? 'Sauvegarde…' : 'Sauvegarder Daily Harvest'}
        </button>
        {saved && (
          <span className="text-xs text-emerald-600 font-medium">✓ Sauvegardé</span>
        )}
        {updateMut.isError && (
          <span className="text-xs text-red-600">Erreur: {String(updateMut.error).slice(0, 80)}</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground mb-1 block">{label}</span>
      {children}
    </label>
  );
}
