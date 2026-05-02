/**
 * ADR-007 PR #207b — Mode presets service.
 *
 * - listBuiltin(mode) : retourne les 4 presets builtin pour un mode donné
 * - listUserPresets(userId, mode) : custom presets de l'utilisateur
 * - saveUserPreset(input) : insert ou update (onConflict user_id+mode+name)
 * - deleteUserPreset(userId, presetId) : RLS owner_only
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  BuiltinPreset,
  ModeType,
  SaveUserPresetInput,
  UserPreset,
} from './types';

@Injectable()
export class ModePresetsService {
  private readonly logger = new Logger(ModePresetsService.name);
  private builtinCache = new Map<ModeType, BuiltinPreset[]>();
  private builtinCacheLoadedAt: Date | null = null;
  private readonly BUILTIN_CACHE_TTL_MS = 5 * 60_000;

  constructor(private readonly supabase: SupabaseService) {}

  async listBuiltin(mode: ModeType): Promise<BuiltinPreset[]> {
    if (this.isBuiltinCacheValid()) {
      return this.builtinCache.get(mode) ?? [];
    }
    await this.reloadBuiltinCache();
    return this.builtinCache.get(mode) ?? [];
  }

  async listUserPresets(userId: string, mode: ModeType): Promise<UserPreset[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from('user_mode_presets')
      .select('*')
      .eq('user_id', userId)
      .eq('mode', mode)
      .order('updated_at', { ascending: false });
    if (error) {
      this.logger.warn(`listUserPresets ${userId} ${mode} failed: ${error.message}`);
      return [];
    }
    return (data ?? []).map(this.mapUserRow);
  }

  async saveUserPreset(input: SaveUserPresetInput): Promise<UserPreset | null> {
    const payload = {
      user_id: input.userId,
      mode: input.mode,
      display_name: input.displayName,
      params: input.params,
      source_preset_key: input.sourcePresetKey ?? null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.supabase
      .getClient()
      .from('user_mode_presets')
      .upsert(payload, { onConflict: 'user_id,mode,display_name' })
      .select('*')
      .maybeSingle();
    if (error || !data) {
      this.logger.error(`saveUserPreset ${input.userId} ${input.mode}/${input.displayName} failed: ${error?.message ?? 'no row'}`);
      return null;
    }
    return this.mapUserRow(data);
  }

  async deleteUserPreset(userId: string, presetId: string): Promise<boolean> {
    const { error } = await this.supabase
      .getClient()
      .from('user_mode_presets')
      .delete()
      .eq('id', presetId)
      .eq('user_id', userId);
    if (error) {
      this.logger.warn(`deleteUserPreset ${userId} ${presetId} failed: ${error.message}`);
      return false;
    }
    return true;
  }

  /**
   * Helper : retourne le preset builtin "MODERATE" (default) d'un mode.
   * Utilisé par l'UI pour pré-sélectionner le preset par défaut.
   */
  async getDefaultPreset(mode: ModeType): Promise<BuiltinPreset | null> {
    const presets = await this.listBuiltin(mode);
    return presets.find((p) => p.presetKey === 'MODERATE')
      ?? presets.find((p) => p.displayOrder === 2)
      ?? presets[0]
      ?? null;
  }

  private isBuiltinCacheValid(): boolean {
    if (!this.builtinCacheLoadedAt) return false;
    return Date.now() - this.builtinCacheLoadedAt.getTime() < this.BUILTIN_CACHE_TTL_MS;
  }

  async reloadBuiltinCache(): Promise<void> {
    const { data, error } = await this.supabase
      .getClient()
      .from('mode_presets_builtin')
      .select('*')
      .order('mode', { ascending: true })
      .order('display_order', { ascending: true });
    if (error) {
      this.logger.error(`reloadBuiltinCache failed: ${error.message}`);
      return;
    }
    this.builtinCache.clear();
    for (const row of data ?? []) {
      const preset = this.mapBuiltinRow(row);
      const list = this.builtinCache.get(preset.mode) ?? [];
      list.push(preset);
      this.builtinCache.set(preset.mode, list);
    }
    this.builtinCacheLoadedAt = new Date();
    this.logger.log(`Builtin presets cache loaded: ${data?.length ?? 0} entries across ${this.builtinCache.size} modes`);
  }

  private mapBuiltinRow(r: any): BuiltinPreset {
    return {
      id: r.id,
      mode: r.mode,
      presetKey: r.preset_key,
      displayName: r.display_name,
      icon: r.icon,
      description: r.description,
      params: r.params,
      sourceRef: r.source_ref,
      warningLevel: r.warning_level ?? 'NONE',
      displayOrder: Number(r.display_order),
    };
  }

  private mapUserRow(r: any): UserPreset {
    return {
      id: r.id,
      userId: r.user_id,
      mode: r.mode,
      displayName: r.display_name,
      params: r.params,
      sourcePresetKey: r.source_preset_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
