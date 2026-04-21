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
      // Hyper-trading personal mode — strictly opt-in, all default off
      HYPER_TRADING_MODE_ENABLED: this.parseBool(
        this.config.get('FEATURE_HYPER_TRADING_MODE_ENABLED'),
        DEFAULT_FLAGS.HYPER_TRADING_MODE_ENABLED,
      ),
      HYPER_TRADING_UI_ENABLED: this.parseBool(
        this.config.get('FEATURE_HYPER_TRADING_UI_ENABLED'),
        DEFAULT_FLAGS.HYPER_TRADING_UI_ENABLED,
      ),
      HYPER_TRADING_RUNTIME_ENABLED: this.parseBool(
        this.config.get('FEATURE_HYPER_TRADING_RUNTIME_ENABLED'),
        DEFAULT_FLAGS.HYPER_TRADING_RUNTIME_ENABLED,
      ),
      HYPER_TRADING_EXECUTION_ENABLED: this.parseBool(
        this.config.get('FEATURE_HYPER_TRADING_EXECUTION_ENABLED'),
        DEFAULT_FLAGS.HYPER_TRADING_EXECUTION_ENABLED,
      ),
      // Sniper personal override
      SNIPER_MODE_ENABLED: this.parseBool(
        this.config.get('FEATURE_SNIPER_MODE_ENABLED'),
        DEFAULT_FLAGS.SNIPER_MODE_ENABLED,
      ),
      SNIPER_MODE_UI_ENABLED: this.parseBool(
        this.config.get('FEATURE_SNIPER_MODE_UI_ENABLED'),
        DEFAULT_FLAGS.SNIPER_MODE_UI_ENABLED,
      ),
      // Broker connections
      BROKER_CONNECTIONS_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_CONNECTIONS_ENABLED'),
        DEFAULT_FLAGS.BROKER_CONNECTIONS_ENABLED,
      ),
      BROKER_SYNC_READ_ONLY_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_SYNC_READ_ONLY_ENABLED'),
        DEFAULT_FLAGS.BROKER_SYNC_READ_ONLY_ENABLED,
      ),
      BROKER_ADAPTER_IB_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_ADAPTER_IB_ENABLED'),
        DEFAULT_FLAGS.BROKER_ADAPTER_IB_ENABLED,
      ),
      BROKER_ADAPTER_SAXO_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_ADAPTER_SAXO_ENABLED'),
        DEFAULT_FLAGS.BROKER_ADAPTER_SAXO_ENABLED,
      ),
      BROKER_ADAPTER_DEGIRO_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_ADAPTER_DEGIRO_ENABLED'),
        DEFAULT_FLAGS.BROKER_ADAPTER_DEGIRO_ENABLED,
      ),
      BROKER_ADAPTER_TRADING212_ENABLED: this.parseBool(
        this.config.get('FEATURE_BROKER_ADAPTER_TRADING212_ENABLED'),
        DEFAULT_FLAGS.BROKER_ADAPTER_TRADING212_ENABLED,
      ),
    };
  }

  isEnabled(key: FeatureFlagKey): boolean {
    return this.getAll()[key];
  }
}
