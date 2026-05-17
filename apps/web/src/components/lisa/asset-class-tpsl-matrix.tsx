'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import {
  useAssetClassTpsl,
  useUpdateAssetClassTpsl,
  type AssetClassTpslRow,
} from '@/hooks/use-asset-class-tpsl';

/**
 * PR #338 — matrice TP/SL par asset_class (5 classes seedées par migrations 0141/0142).
 *
 * La DB stocke en décimal (0.030 = 3 %). L'UI affiche en pourcentage humain (× 100)
 * pour TP/SL et applique la conversion inverse au save. Les autres colonnes
 * (warmup_min_override, score_min_floor, path_eff_floor) sont déjà en unités humaines.
 */

const SEED_BASELINE = '2026-05-16T00:00:00Z'; // mig 0141 + 0142 appliquées le 16 mai

const COLUMNS = [
  { key: 'asset_class' as const, label: 'Classe' },
  { key: 'tp_pct' as const, label: 'TP (%)' },
  { key: 'sl_pct' as const, label: 'SL (%)' },
  { key: 'warmup_min_override' as const, label: 'Warmup (min)' },
  { key: 'score_min_floor' as const, label: 'Score floor' },
  { key: 'path_eff_floor' as const, label: 'Path eff floor' },
  { key: 'regime_filter_enabled' as const, label: 'Régime' },
];

function fmtClass(c: string): string {
  return c
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

interface Draft {
  tp_pct: string;
  sl_pct: string;
  warmup_min_override: string;
  score_min_floor: string;
  path_eff_floor: string;
  regime_filter_enabled: boolean;
}

function toDraft(row: AssetClassTpslRow): Draft {
  return {
    tp_pct: (row.tp_pct * 100).toFixed(3),
    sl_pct: (row.sl_pct * 100).toFixed(3),
    warmup_min_override: row.warmup_min_override?.toString() ?? '',
    score_min_floor: row.score_min_floor?.toString() ?? '',
    path_eff_floor: row.path_eff_floor?.toString() ?? '',
    regime_filter_enabled: row.regime_filter_enabled,
  };
}

export function AssetClassTpslMatrix() {
  const q = useAssetClassTpsl();
  const update = useUpdateAssetClassTpsl();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [errorMsg, setErrorMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    if (q.data) {
      const next: Record<string, Draft> = {};
      for (const row of q.data) next[row.asset_class] = toDraft(row);
      setDrafts(next);
    }
  }, [q.data]);

  if (q.isLoading) {
    return <div className="text-sm text-muted-foreground italic">Chargement de la matrice…</div>;
  }
  if (q.isError) {
    return <div className="text-sm text-red-600">Erreur de chargement : {String(q.error)}</div>;
  }

  const rows = q.data ?? [];

  const handleSave = async (row: AssetClassTpslRow) => {
    const d = drafts[row.asset_class];
    if (!d) return;
    setErrorMsg((m) => ({ ...m, [row.asset_class]: '' }));

    const tpDec = Number.parseFloat(d.tp_pct) / 100;
    const slDec = Number.parseFloat(d.sl_pct) / 100;
    const warmup = d.warmup_min_override.trim() === '' ? null : Number.parseInt(d.warmup_min_override, 10);
    const score = d.score_min_floor.trim() === '' ? null : Number.parseFloat(d.score_min_floor);
    const pathEff = d.path_eff_floor.trim() === '' ? null : Number.parseFloat(d.path_eff_floor);

    try {
      await update.mutateAsync({
        assetClass: row.asset_class,
        patch: {
          tp_pct: tpDec,
          sl_pct: slDec,
          warmup_min_override: warmup,
          score_min_floor: score,
          path_eff_floor: pathEff,
          regime_filter_enabled: d.regime_filter_enabled,
        },
      });
      setSavedAt((m) => ({ ...m, [row.asset_class]: Date.now() }));
      setTimeout(() => {
        setSavedAt((m) => {
          const copy = { ...m };
          delete copy[row.asset_class];
          return copy;
        });
      }, 3000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg((m) => ({ ...m, [row.asset_class]: msg }));
    }
  };

  const handleReset = (row: AssetClassTpslRow) => {
    setDrafts((d) => ({ ...d, [row.asset_class]: toDraft(row) }));
    setErrorMsg((m) => ({ ...m, [row.asset_class]: '' }));
  };

  const seedBaselineMs = new Date(SEED_BASELINE).getTime();

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-3 py-2 text-left font-medium">
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const d = drafts[row.asset_class];
              if (!d) return null;
              const wasOverridden = new Date(row.updated_at).getTime() > seedBaselineMs;
              const isSaved = savedAt[row.asset_class];
              const err = errorMsg[row.asset_class];

              return (
                <tr key={row.asset_class} className="border-b last:border-b-0">
                  <td className="px-3 py-2 font-medium">
                    <div className="flex flex-col">
                      <span>{fmtClass(row.asset_class)}</span>
                      {wasOverridden && (
                        <span className="text-xs text-amber-600 dark:text-amber-500">
                          Override actif depuis {new Date(row.updated_at).toLocaleDateString('fr-FR')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="10"
                      value={d.tp_pct}
                      onChange={(e) =>
                        setDrafts((m) => ({ ...m, [row.asset_class]: { ...d, tp_pct: e.target.value } }))
                      }
                      className="w-20 rounded border bg-background px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="-5"
                      max="-0.01"
                      value={d.sl_pct}
                      onChange={(e) =>
                        setDrafts((m) => ({ ...m, [row.asset_class]: { ...d, sl_pct: e.target.value } }))
                      }
                      className="w-20 rounded border bg-background px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="120"
                      placeholder="—"
                      value={d.warmup_min_override}
                      onChange={(e) =>
                        setDrafts((m) => ({
                          ...m,
                          [row.asset_class]: { ...d, warmup_min_override: e.target.value },
                        }))
                      }
                      className="w-20 rounded border bg-background px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="5"
                      placeholder="—"
                      value={d.score_min_floor}
                      onChange={(e) =>
                        setDrafts((m) => ({
                          ...m,
                          [row.asset_class]: { ...d, score_min_floor: e.target.value },
                        }))
                      }
                      className="w-20 rounded border bg-background px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      placeholder="—"
                      value={d.path_eff_floor}
                      onChange={(e) =>
                        setDrafts((m) => ({
                          ...m,
                          [row.asset_class]: { ...d, path_eff_floor: e.target.value },
                        }))
                      }
                      className="w-20 rounded border bg-background px-2 py-1 text-right"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={d.regime_filter_enabled}
                      onChange={(e) =>
                        setDrafts((m) => ({
                          ...m,
                          [row.asset_class]: { ...d, regime_filter_enabled: e.target.checked },
                        }))
                      }
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2 items-center">
                      {isSaved && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="Sauvegardé" />
                      )}
                      <button
                        type="button"
                        onClick={() => handleReset(row)}
                        title="Réinitialiser à la valeur DB courante"
                        className="rounded border px-2 py-1 hover:bg-muted/50"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSave(row)}
                        disabled={update.isPending}
                        className="rounded bg-primary text-primary-foreground px-3 py-1 text-xs disabled:opacity-50"
                      >
                        {update.isPending ? '…' : 'Sauvegarder'}
                      </button>
                    </div>
                    {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="p-3 text-xs text-muted-foreground bg-muted/30 border-t">
        Modifications appliquées immédiatement au prochain cycle scanner. TP/SL affichés en pourcentage humain (×100 vs stockage décimal en DB).
      </div>
    </div>
  );
}
