import { Controller, Get, Param, Headers, UnauthorizedException } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('portfolios')
export class PortfolioController {
  constructor(
    private readonly portfolios: PortfolioService,
    private readonly supabase: SupabaseService,
  ) {}

  private async resolveUser(authHeader: string | undefined) {
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = authHeader.slice(7);
    const { data: { user }, error } = await this.supabase
      .getClient()
      .auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
    return user;
  }

  @Get()
  async list(@Headers('authorization') auth: string) {
    const user = await this.resolveUser(auth);
    return { ok: true, data: await this.portfolios.listForUser(user.id) };
  }

  @Get(':id')
  async getOne(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    await this.resolveUser(auth);
    return { ok: true, data: await this.portfolios.getById(id) };
  }
}
