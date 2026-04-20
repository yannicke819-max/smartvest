import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Headers,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { AlertRulesService, AlertRuleKind, AlertSeverity } from './alert-rules.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller()
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly rules: AlertRulesService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('portfolio/:portfolioId/alerts')
  async getAlerts(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Query('riskProfile') riskProfile?: string,
    @Query('persisted') persisted?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    await this.requireAuth(auth);

    if (persisted === 'true') {
      const data = await this.rules.listAlerts(portfolioId, { unreadOnly: unreadOnly === 'true' });
      return { ok: true, data };
    }

    const result = await this.alerts.getAlerts(portfolioId, riskProfile);
    return { ok: true, data: result };
  }

  @Post('portfolio/:portfolioId/alerts/evaluate')
  async evaluate(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.rules.evaluate(portfolioId);
    return { ok: true, data };
  }

  @Get('portfolio/:portfolioId/alerts/rules')
  async listRules(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.rules.listRules(portfolioId);
    return { ok: true, data };
  }

  @Post('portfolio/:portfolioId/alerts/rules')
  async upsertRule(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Body() body: {
      id?: string;
      ruleKind: AlertRuleKind;
      severity?: AlertSeverity;
      enabled?: boolean;
      params?: Record<string, unknown>;
      cooldownSeconds?: number;
    },
  ) {
    const userId = await this.requireAuth(auth);
    const data = await this.rules.upsertRule({ ...body, userId, portfolioId });
    return { ok: true, data };
  }

  @Delete('alerts/rules/:ruleId')
  async deleteRule(
    @Headers('authorization') auth: string,
    @Param('ruleId') ruleId: string,
  ) {
    const userId = await this.requireAuth(auth);
    const ok = await this.rules.deleteRule(userId, ruleId);
    return { ok };
  }

  @Post('alerts/:alertId/read')
  async markRead(
    @Headers('authorization') auth: string,
    @Param('alertId') alertId: string,
  ) {
    const userId = await this.requireAuth(auth);
    await this.rules.markRead(alertId, userId);
    return { ok: true };
  }

  @Post('alerts/:alertId/dismiss')
  async dismiss(
    @Headers('authorization') auth: string,
    @Param('alertId') alertId: string,
  ) {
    const userId = await this.requireAuth(auth);
    await this.rules.dismiss(alertId, userId);
    return { ok: true };
  }

  private async requireAuth(auth: string): Promise<string> {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
    return user.id;
  }
}
