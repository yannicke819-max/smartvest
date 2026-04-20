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
    };
  }

  isEnabled(key: FeatureFlagKey): boolean {
    return this.getAll()[key];
  }
}
