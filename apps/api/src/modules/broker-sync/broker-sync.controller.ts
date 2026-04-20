import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Headers,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { BrokerSyncService } from './services/broker-sync.service';
import { SupabaseService } from '../supabase/supabase.service';
import { SyncKind } from './dto/broker-sync.dto';

@Controller('broker-sync')
export class BrokerSyncController {
  constructor(
    private readonly sync: BrokerSyncService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get('connections')
  async listConnections(
    @Headers('authorization') auth: string,
    @Query('portfolioId') portfolioId: string,
  ) {
    const userId = await this.requireAuth(auth);
    if (!portfolioId) throw new BadRequestException('portfolioId manquant');
    const data = await this.sync.listConnections(userId, portfolioId);
    return { ok: true, data };
  }

  @Get('jobs')
  async listJobs(
    @Headers('authorization') auth: string,
    @Query('portfolioId') portfolioId: string,
  ) {
    const userId = await this.requireAuth(auth);
    if (!portfolioId) throw new BadRequestException('portfolioId manquant');
    const data = await this.sync.listSyncJobs(userId, portfolioId);
    return { ok: true, data };
  }

  @Post('trigger')
  async trigger(
    @Headers('authorization') auth: string,
    @Body() body: { portfolioId: string; connectionId?: string; syncKind: SyncKind },
  ) {
    const userId = await this.requireAuth(auth);
    if (!body.portfolioId) throw new BadRequestException('portfolioId manquant');
    const result = await this.sync.createSyncJob({
      userId,
      portfolioId: body.portfolioId,
      connectionId: body.connectionId ?? null,
      syncKind: body.syncKind,
    });
    return { ok: true, data: result };
  }

  private async requireAuth(auth: string): Promise<string> {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
    return user.id;
  }
}
