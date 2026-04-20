import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { BrokerImportService } from './services/broker-import.service';
import { PortfolioReconstitutionService } from './services/portfolio-reconstitution.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ParserRegistry } from './parsers/parser-registry';

@Controller('imports')
export class BrokerImportController {
  constructor(
    private readonly imports: BrokerImportService,
    private readonly reconstitution: PortfolioReconstitutionService,
    private readonly supabase: SupabaseService,
    private readonly registry: ParserRegistry,
  ) {}

  @Get('formats')
  async listFormats() {
    return {
      ok: true,
      data: this.registry.getAll().map((a) => ({ format: a.format, label: a.label })),
    };
  }

  @Post('preview')
  async preview(
    @Headers('authorization') auth: string,
    @Body() body: {
      portfolioId: string;
      accountId?: string;
      csvContent: string;
      filename?: string;
      brokerFormat?: string;
    },
  ) {
    const userId = await this.requireAuth(auth);
    if (!body.portfolioId) throw new BadRequestException('portfolioId manquant');
    if (!body.csvContent) throw new BadRequestException('csvContent manquant');

    const result = await this.imports.preview({
      userId,
      portfolioId: body.portfolioId,
      accountId: body.accountId ?? null,
      csvContent: body.csvContent,
      filename: body.filename ?? null,
      brokerFormat: body.brokerFormat ?? null,
    });
    return { ok: true, data: result };
  }

  @Post(':jobId/commit')
  async commit(
    @Headers('authorization') auth: string,
    @Param('jobId') jobId: string,
    @Body() body: { rowsToSkip?: number[] },
  ) {
    const userId = await this.requireAuth(auth);
    const result = await this.imports.commit(userId, jobId, body.rowsToSkip ?? []);

    // Kick reconstitution if any row was committed
    let reconstitution = null;
    if (result.rowsCommitted > 0 && this.supabase.isReady()) {
      const { data: job } = await this.supabase
        .getClient()
        .from('import_jobs')
        .select('portfolio_id')
        .eq('id', jobId)
        .single();
      if (job) {
        reconstitution = await this.reconstitution.reconstitute(job.portfolio_id as string);
      }
    }

    return { ok: true, data: { ...result, reconstitution } };
  }

  @Get('history')
  async history(
    @Headers('authorization') auth: string,
    @Query('portfolioId') portfolioId: string,
  ) {
    const userId = await this.requireAuth(auth);
    if (!portfolioId) throw new BadRequestException('portfolioId manquant');
    const data = await this.imports.history(userId, portfolioId);
    return { ok: true, data };
  }

  private async requireAuth(auth: string): Promise<string> {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = auth.slice(7);
    const { data: { user }, error } = await this.supabase.getClient().auth.getUser(token);
    if (error || !user) throw new UnauthorizedException();
    return user.id;
  }
}
