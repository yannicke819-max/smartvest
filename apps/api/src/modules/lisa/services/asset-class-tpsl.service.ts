import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export interface AssetClassTpslRow {
  asset_class: string;
  tp_pct: number;
  sl_pct: number;
  warmup_min_override: number | null;
  regime_filter_enabled: boolean;
  score_min_floor: number | null;
  path_eff_floor: number | null;
  notes: string | null;
  updated_at: string;
}

/**
 * PR #338 — service de lecture/écriture pour la matrice TP/SL par asset_class
 * (table `asset_class_tpsl_config`, migrations 0141 + 0142).
 *
 * Lecture : list ordonnée pour le panel UI parameters.
 * Écriture : update partiel avec whitelist colonnes + clamps stricts cohérents
 * avec les CHECK constraints SQL.
 */
@Injectable()
export class AssetClassTpslService {
  private static readonly ALLOWED_CLASSES = [
    'us_equity_large',
    'us_equity_small_mid',
    'eu_equity',
    'asia_equity',
    'crypto_major',
  ];

  constructor(private readonly supabase: SupabaseService) {}

  static isAllowedClass(assetClass: string): boolean {
    return AssetClassTpslService.ALLOWED_CLASSES.includes(assetClass);
  }

  async list(): Promise<AssetClassTpslRow[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('asset_class_tpsl_config')
      .select('asset_class, tp_pct, sl_pct, warmup_min_override, regime_filter_enabled, score_min_floor, path_eff_floor, notes, updated_at')
      .order('asset_class');
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as AssetClassTpslRow[];
  }

  async update(assetClass: string, patch: Record<string, unknown>): Promise<AssetClassTpslRow> {
    if (!AssetClassTpslService.isAllowedClass(assetClass)) {
      throw new BadRequestException(`asset_class inconnu : ${assetClass}`);
    }

    const allowed = [
      'tp_pct',
      'sl_pct',
      'warmup_min_override',
      'regime_filter_enabled',
      'score_min_floor',
      'path_eff_floor',
      'notes',
    ] as const;

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (patch[k] !== undefined) payload[k] = patch[k];
    }

    if (typeof payload.tp_pct === 'number' && (payload.tp_pct <= 0 || payload.tp_pct > 0.1)) {
      throw new BadRequestException('tp_pct doit être dans (0, 0.10]');
    }
    if (typeof payload.sl_pct === 'number' && (payload.sl_pct >= 0 || payload.sl_pct < -0.05)) {
      throw new BadRequestException('sl_pct doit être dans [-0.05, 0)');
    }
    if (typeof payload.score_min_floor === 'number' && (payload.score_min_floor < 0 || payload.score_min_floor > 5)) {
      throw new BadRequestException('score_min_floor doit être dans [0, 5]');
    }
    if (typeof payload.path_eff_floor === 'number' && (payload.path_eff_floor < 0 || payload.path_eff_floor > 1)) {
      throw new BadRequestException('path_eff_floor doit être dans [0, 1]');
    }
    if (typeof payload.warmup_min_override === 'number' && (payload.warmup_min_override < 0 || payload.warmup_min_override > 120)) {
      throw new BadRequestException('warmup_min_override doit être dans [0, 120] minutes');
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('asset_class_tpsl_config')
      .update(payload)
      .eq('asset_class', assetClass)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data as AssetClassTpslRow;
  }
}
