/**
 * ADR-007 PR #207b — Mode presets types.
 */

export type ModeType = 'INVESTMENT' | 'HARVEST' | 'GAINERS';
export type WarningLevel = 'NONE' | 'CAUTION' | 'KAMIKAZE';

export interface BuiltinPreset {
  id: string;
  mode: ModeType;
  presetKey: string;
  displayName: string;
  icon: string;
  description: string;
  params: Record<string, unknown>;
  sourceRef: string;
  warningLevel: WarningLevel;
  displayOrder: number;
}

export interface UserPreset {
  id: string;
  userId: string;
  mode: ModeType;
  displayName: string;
  params: Record<string, unknown>;
  sourcePresetKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveUserPresetInput {
  userId: string;
  mode: ModeType;
  displayName: string;
  params: Record<string, unknown>;
  sourcePresetKey?: string;
}
