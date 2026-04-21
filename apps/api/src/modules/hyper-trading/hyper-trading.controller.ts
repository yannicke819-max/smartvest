import {
  Controller, Get, Post, Patch, Param, Body, Query, Headers, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { HyperTradingProfileService } from './services/hyper-trading-profile.service';
import { HyperTradingAuditService } from './services/hyper-trading-audit.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import {
  ConfigureHyperTradingSchema,
  UpdateGuardrailSchema,
  PauseProfileSchema,
  ResumeProfileSchema,
  KillSwitchSchema,
  CreateWindowSchema,
  ListAuditQuerySchema,
  SelectStrategyModeSchema,
} from './dto/hyper-trading.dto';
import { TEMPO_REVIEW_INTERVAL_MINUTES, TEMPO_RISK_LEVEL } from '@smartvest/shared-types';

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

/**
 * Both /strategy-modes and /hyper-trading endpoints live in this single
 * controller. The two share the underlying service and feature gate.
 */
@Controller()
export class HyperTradingController {
  constructor(
    private readonly profileSvc: HyperTradingProfileService,
    private readonly auditSvc: HyperTradingAuditService,
    private readonly flags: FeatureFlagsService,
  ) {}

  private requireFeatureEnabled() {
    if (!this.flags.isEnabled('HYPER_TRADING_MODE_ENABLED')) {
      throw new ForbiddenException('Mode hyper-trading désactivé (feature flag off)');
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // /strategy-modes — coarse selection (lightweight)
  // ────────────────────────────────────────────────────────────────────
  @Get('strategy-modes')
  listStrategyModes() {
    return ['LONG_HORIZON', 'ACTIVE', 'HYPER_ACTIVE'].map((tempo) => ({
      tempo,
      reviewIntervalMinutes: TEMPO_REVIEW_INTERVAL_MINUTES[tempo as keyof typeof TEMPO_REVIEW_INTERVAL_MINUTES],
      riskLevel: TEMPO_RISK_LEVEL[tempo as keyof typeof TEMPO_RISK_LEVEL],
    }));
  }

  @Get('strategy-modes/current')
  async getCurrentStrategyMode(@Headers() headers: Record<string, string>) {
    const userId = extractUserId(headers);
    const profile = await this.profileSvc.getCurrent(userId);
    return {
      tempo: (profile as { tempo?: string } | null)?.tempo ?? 'LONG_HORIZON',
      profile,
    };
  }

  @Post('strategy-modes/select')
  async selectStrategyMode(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    this.requireFeatureEnabled();
    const dto = parse(SelectStrategyModeSchema, body);
    const userId = extractUserId(headers);
    // No-op for LONG_HORIZON / ACTIVE — hyper-trading profile is only created for HYPER_ACTIVE
    if (dto.tempo !== 'HYPER_ACTIVE') {
      return { tempo: dto.tempo, profile: null, message: 'Sélection enregistrée (aucun profil hyper-trading nécessaire)' };
    }
    return { tempo: dto.tempo, message: 'Sélection enregistrée — utilisez POST /hyper-trading/configure pour créer un profil' };
  }

  // ────────────────────────────────────────────────────────────────────
  // /hyper-trading — configuration et lifecycle
  // ────────────────────────────────────────────────────────────────────
  @Get('hyper-trading/config')
  async getConfig(@Headers() headers: Record<string, string>) {
    const userId = extractUserId(headers);
    const profile = await this.profileSvc.getCurrent(userId);
    if (!profile) return { profile: null, guardrail: null };
    const guardrail = await this.profileSvc.getGuardrail((profile as { id: string }).id, userId);
    return { profile, guardrail };
  }

  @Post('hyper-trading/configure')
  async configure(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    this.requireFeatureEnabled();
    const dto = parse(ConfigureHyperTradingSchema, body);
    return this.profileSvc.configure(extractUserId(headers), dto);
  }

  @Get('hyper-trading/guardrails')
  async getGuardrail(@Headers() headers: Record<string, string>) {
    const userId = extractUserId(headers);
    const profile = await this.profileSvc.getCurrent(userId);
    if (!profile) return null;
    return this.profileSvc.getGuardrail((profile as { id: string }).id, userId);
  }

  @Patch('hyper-trading/guardrails/:profileId')
  async patchGuardrail(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
  ) {
    this.requireFeatureEnabled();
    const dto = parse(UpdateGuardrailSchema, body);
    return this.profileSvc.updateGuardrail(profileId, extractUserId(headers), dto);
  }

  @Post('hyper-trading/:profileId/activate')
  activate(@Headers() headers: Record<string, string>, @Param('profileId') profileId: string) {
    this.requireFeatureEnabled();
    return this.profileSvc.activate(profileId, extractUserId(headers));
  }

  @Post('hyper-trading/:profileId/pause')
  pause(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
  ) {
    const dto = parse(PauseProfileSchema, body ?? {});
    return this.profileSvc.pause(profileId, extractUserId(headers), dto.reason ?? 'Pause manuelle');
  }

  @Post('hyper-trading/:profileId/resume')
  resume(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
  ) {
    this.requireFeatureEnabled();
    const dto = parse(ResumeProfileSchema, body ?? {});
    return this.profileSvc.resume(profileId, extractUserId(headers), dto.reason ?? 'Reprise manuelle');
  }

  @Post('hyper-trading/:profileId/kill')
  kill(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
  ) {
    const dto = parse(KillSwitchSchema, body);
    return this.profileSvc.kill(profileId, extractUserId(headers), dto.reason);
  }

  @Post('hyper-trading/:profileId/deactivate')
  deactivate(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
  ) {
    return this.profileSvc.archive(profileId, extractUserId(headers), 'Désactivation manuelle');
  }

  // ────────────────────────────────────────────────────────────────────
  // Trading windows
  // ────────────────────────────────────────────────────────────────────
  @Get('hyper-trading/:profileId/windows')
  listWindows(@Headers() headers: Record<string, string>, @Param('profileId') profileId: string) {
    return this.profileSvc.listWindows(profileId, extractUserId(headers));
  }

  @Post('hyper-trading/:profileId/windows')
  createWindow(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Body() body: unknown,
  ) {
    this.requireFeatureEnabled();
    const dto = parse(CreateWindowSchema, body);
    return this.profileSvc.createWindow(profileId, extractUserId(headers), dto);
  }

  // ────────────────────────────────────────────────────────────────────
  // Audit
  // ────────────────────────────────────────────────────────────────────
  @Get('hyper-trading/:profileId/audit')
  async listAudit(
    @Headers() headers: Record<string, string>,
    @Param('profileId') profileId: string,
    @Query() query: unknown,
  ) {
    const dto = parse(ListAuditQuerySchema, query);
    return this.auditSvc.listForProfile(profileId, extractUserId(headers), dto.limit);
  }
}
