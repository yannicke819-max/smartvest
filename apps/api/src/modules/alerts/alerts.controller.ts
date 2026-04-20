import { Controller, Get, Param, Headers, Query, UnauthorizedException } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portfolio')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get(':portfolioId/alerts')
  async getAlerts(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Query('riskProfile') riskProfile?: string,
  ) {
    await this.requireAuth(auth);
    const result = await this.alerts.getAlerts(portfolioId, riskProfile);
    return { ok: true, data: result };
  }

  private async requireAuth(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
  }
}
