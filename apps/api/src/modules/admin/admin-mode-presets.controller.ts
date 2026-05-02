/**
 * /admin/mode-presets — endpoints presets (read-only builtin + read user customs).
 *
 * ADR-007 PR #207b — bouton 1-clic 4 presets par mode.
 *
 * - GET /admin/mode-presets/:mode → 4 builtin presets ordonnés (CONSERVATIVE
 *   → MODERATE → AGGRESSIVE → AGGRESSIVE_GROWTH/SCALPER/KAMIKAZE selon mode)
 *
 * Auth via x-admin-token. UI pour /me/mode-presets côté user = PR #207c.
 */

import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  ParseEnumPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModePresetsService } from '../gainers-scanner/presets/mode-presets.service';

enum ModeParam {
  INVESTMENT = 'INVESTMENT',
  HARVEST = 'HARVEST',
  GAINERS = 'GAINERS',
}

@Controller('admin/mode-presets')
export class AdminModePresetsController {
  constructor(
    private readonly presets: ModePresetsService,
    private readonly config: ConfigService,
  ) {}

  @Get(':mode')
  async listBuiltin(
    @Headers('x-admin-token') providedToken: string | undefined,
    @Param('mode', new ParseEnumPipe(ModeParam)) mode: ModeParam,
  ) {
    this.assertAdmin(providedToken);
    const presets = await this.presets.listBuiltin(mode);
    return {
      mode,
      count: presets.length,
      presets,
      defaultPresetKey: presets.find((p) => p.presetKey === 'MODERATE')?.presetKey ?? presets[0]?.presetKey ?? null,
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    const expected = this.config.get<string>('ADMIN_TOKEN');
    if (!expected || expected.length === 0) {
      throw new HttpException(
        { message: 'Endpoint disabled (ADMIN_TOKEN not configured)', code: 'ADMIN_DISABLED' },
        HttpStatus.FORBIDDEN,
      );
    }
    if (providedToken !== expected) {
      throw new HttpException(
        { message: 'Invalid admin token', code: 'ADMIN_FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
