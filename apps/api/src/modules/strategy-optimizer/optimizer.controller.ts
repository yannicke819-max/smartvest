import { BadRequestException, Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import {
  OptimizerRunParamsSchema,
  type OptimizerCandidate,
} from '@smartvest/strategy-optimizer';
import { OptimizerService } from './optimizer.service';

/**
 * Endpoints strategy-optimizer.
 *
 * Phase A : POST /optimizer/run avec mode=single_shot
 * Phase C : POST /optimizer/run avec mode=walk_forward
 * Phase B : POST /optimizer/run avec mode=auto_apply (déclenche évaluation +
 *          apply si tous les garde-fous OK)
 *
 * Auth : header X-User-Id pour développement (Supabase auth normalement).
 */
@Controller('optimizer')
export class OptimizerController {
  constructor(private readonly service: OptimizerService) {}

  @Post('run')
  async run(
    @Headers('x-user-id') userId: string | undefined,
    @Body() body: unknown,
  ) {
    const uid = this.requireUserId(userId);
    const parsed = OptimizerRunParamsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `Paramètres invalides : ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }
    return this.service.run(uid, parsed.data);
  }

  @Get('auto/state')
  async getAutoState(@Headers('x-user-id') userId: string | undefined) {
    const uid = this.requireUserId(userId);
    return this.service.getAutoState(uid);
  }

  @Post('auto/toggle')
  async toggleAuto(
    @Headers('x-user-id') userId: string | undefined,
    @Body() body: { enabled: boolean },
  ) {
    const uid = this.requireUserId(userId);
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('body.enabled doit être un booléen.');
    }
    return this.service.setAutoEnabled(uid, body.enabled);
  }

  @Get('runs')
  async listRuns(
    @Headers('x-user-id') userId: string | undefined,
    @Query('limit') limit?: string,
  ) {
    const uid = this.requireUserId(userId);
    const n = limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20;
    return this.service.listRuns(uid, n);
  }

  @Post('apply')
  async applyCandidate(
    @Headers('x-user-id') userId: string | undefined,
    @Body() body: { candidate: OptimizerCandidate },
  ) {
    const uid = this.requireUserId(userId);
    if (!body.candidate) throw new BadRequestException('body.candidate requis.');
    await this.service.applyCandidate(uid, body.candidate);
    return { ok: true, applied: body.candidate };
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId) {
      throw new BadRequestException('Header X-User-Id requis.');
    }
    return userId;
  }
}
