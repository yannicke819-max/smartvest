import { Controller, Get, Param, Headers, UnauthorizedException } from '@nestjs/common';
import { ValuationService } from './valuation.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portfolio')
export class ValuationController {
  constructor(
    private readonly valuation: ValuationService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get(':portfolioId/valuation')
  async getValuation(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    return { ok: true, data: await this.valuation.getPortfolioValuation(portfolioId) };
  }

  @Get(':portfolioId/allocation')
  async getAllocation(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    return { ok: true, data: await this.valuation.getAllocationBreakdown(portfolioId) };
  }

  @Get(':portfolioId/performance-summary')
  async getPerformanceSummary(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    return { ok: true, data: await this.valuation.getPerformanceSummary(portfolioId) };
  }

  private async requireAuth(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
  }
}
