import {
  Controller,
  Post,
  Param,
  Headers,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { SimulationsService } from './simulations.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portfolio')
export class SimulationsController {
  constructor(
    private readonly simulations: SimulationsService,
    private readonly supabase: SupabaseService,
  ) {}

  @Post(':portfolioId/simulations/rebalance-preview')
  async rebalancePreview(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { targets?: Array<{ assetClass: string; targetWeight: number }> },
  ) {
    await this.requireAuth(auth);
    const result = await this.simulations.previewRebalance(portfolioId, body.targets);
    return { ok: true, data: result };
  }

  @Post(':portfolioId/simulations/contribution-preview')
  async contributionPreview(
    @Headers('authorization') auth: string,
    @Param('portfolioId') portfolioId: string,
    @Body() body: { amount: string; currency: string },
  ) {
    await this.requireAuth(auth);
    const result = await this.simulations.previewContribution(
      portfolioId,
      body.amount,
      body.currency,
    );
    return { ok: true, data: result };
  }

  private async requireAuth(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
  }
}
