import { Controller, Get, Param, Headers, UnauthorizedException } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get(':portfolioId/summary')
  async summary(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase
      .getClient()
      .auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();

    return { ok: true, data: await this.dashboard.getSummary(portfolioId) };
  }
}
