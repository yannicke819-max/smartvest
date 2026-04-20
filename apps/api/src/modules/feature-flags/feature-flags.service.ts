import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_FLAGS, FeatureFlags, FeatureFlagKey } from '@smartvest/shared-types';

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly config: ConfigService) {}

  private parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }

  getAll(): FeatureFlags {
    return {
      // Product access modes
      PERSONAL_MODE: this.parseBool(
        this.config.get('NEXT_PUBLIC_FEATURE_PERSONAL_MODE'),
        DEFAULT_FLAGS.PERSONAL_MODE,
      ),
      SAFE_PUBLIC_MODE: this.parseBool(
        this.config.get('NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE'),
        DEFAULT_FLAGS.SAFE_PUBLIC_MODE,
      ),
      REGULATED_MODE: this.parseBool(
        this.config.get('NEXT_PUBLIC_FEATURE_REGULATED_MODE'),
        DEFAULT_FLAGS.REGULATED_MODE,
      ),
      // Delegation modes
      DELEGATION_MANUAL_EXPLICIT: this.parseBool(
        this.config.get('FEATURE_DELEGATION_MANUAL_EXPLICIT') ??
        this.config.get('FEATURE_MANUAL_MODE_ENABLED'),
        DEFAULT_FLAGS.DELEGATION_MANUAL_EXPLICIT,
      ),
      DELEGATION_HYBRID_SUGGESTIVE: this.parseBool(
        this.config.get('FEATURE_DELEGATION_HYBRID_SUGGESTIVE') ??
        this.config.get('FEATURE_HYBRID_MODE_ENABLED'),
        DEFAULT_FLAGS.DELEGATION_HYBRID_SUGGESTIVE,
      ),
      DELEGATION_AUTONOMOUS_GUARDED: this.parseBool(
        this.config.get('FEATURE_DELEGATION_AUTONOMOUS_GUARDED') ??
        this.config.get('FEATURE_AUTONOMOUS_MODE_ENABLED'),
        DEFAULT_FLAGS.DELEGATION_AUTONOMOUS_GUARDED,
      ),
      // Autonomy safety — kill-switch defaults to OFF (false = not killing)
      AUTONOMY_KILL_SWITCH: this.parseBool(
        this.config.get('FEATURE_AUTONOMY_KILL_SWITCH'),
        DEFAULT_FLAGS.AUTONOMY_KILL_SWITCH,
      ),
      // Broker integration
      BROKER_EXECUTION_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_EXECUTION_ENABLED'),
        DEFAULT_FLAGS.BROKER_EXECUTION_ENABLED,
      ),
      READ_ONLY_BROKER_SYNC_ENABLED: this.parseBool(
        this.config.get('FEATURE_READ_ONLY_BROKER_SYNC_ENABLED'),
        DEFAULT_FLAGS.READ_ONLY_BROKER_SYNC_ENABLED,
      ),
    };
  }

  isEnabled(key: FeatureFlagKey): boolean {
    return this.getAll()[key];
  }
}
