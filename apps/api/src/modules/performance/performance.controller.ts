import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { PerformanceService } from './performance.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portfolio')
export class PerformanceController {
  constructor(
    private readonly performance: PerformanceService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get(':portfolioId/history')
  async history(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.performance.getHistory(portfolioId, from, to);
    return { ok: true, data };
  }

  @Get(':portfolioId/performance-metrics')
  async metrics(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.performance.computeMetrics(portfolioId);
    return { ok: true, data };
  }

  @Get(':portfolioId/benchmark')
  async benchmark(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.performance.compareToBenchmark(portfolioId);
    return { ok: true, data };
  }

  @Post(':portfolioId/history/snapshot')
  async takeSnapshot(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
  ) {
    await this.requireAuth(auth);
    const data = await this.performance.takeSnapshot(portfolioId);
    return { ok: true, data };
  }

  private async requireAuth(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
  }
}
