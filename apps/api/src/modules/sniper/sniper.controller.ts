import {
  Controller, Get, Post, Headers, Body, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { SniperService } from './sniper.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { UnlockSniperSchema, DeactivateSniperSchema } from './dto/sniper.dto';

function extractUserId(headers: Record<string, string>): string {
  return headers['x-user-id'] ?? 'demo-user';
}

function parse<T>(
  schema: { safeParse: (x: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } } },
  body: unknown,
): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({ message: 'Validation échouée', issues: r.error?.issues });
  }
  return r.data as T;
}

@Controller('sniper')
export class SniperController {
  constructor(
    private readonly sniper: SniperService,
    private readonly flags: FeatureFlagsService,
  ) {}

  private requireEnabled() {
    if (!this.flags.isEnabled('SNIPER_MODE_ENABLED')) {
      throw new ForbiddenException('Mode sniper désactivé (feature flag off)');
    }
  }

  /**
   * Always callable — even with the flag off, the UI needs to know the current
   * state to render correctly. Returns STANDARD when no session exists.
   */
  @Get('status')
  getStatus(@Headers() headers: Record<string, string>) {
    return this.sniper.getStatus(extractUserId(headers));
  }

  @Post('unlock')
  unlock(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    this.requireEnabled();
    const dto = parse(UnlockSniperSchema, body);
    return this.sniper.unlock(extractUserId(headers), dto.code, dto.ttlMinutes);
  }

  /**
   * Deactivation never gated — safety wins over feature gating.
   */
  @Post('deactivate')
  deactivate(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    parse(DeactivateSniperSchema, body ?? {});
    return this.sniper.deactivate(extractUserId(headers));
  }

  @Get('history')
  history(@Headers() headers: Record<string, string>) {
    return this.sniper.listHistory(extractUserId(headers));
  }
}
