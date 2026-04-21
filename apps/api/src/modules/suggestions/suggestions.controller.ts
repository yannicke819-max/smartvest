import { Controller, Get, Post, Param, Body, Query, Headers, HttpCode, BadRequestException } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { SuggestionsService } from './services/suggestions.service';
import {
  ApproveProposalSchema,
  RejectProposalSchema,
  CancelProposalSchema,
  ListProposalsQuerySchema,
} from './dto/suggestions.dto';

function extractUserId(headers: Record<string, string>): string {
  const id = headers['x-user-id'];
  if (!id) throw new UnauthorizedException('x-user-id header manquant');
  return id;
}

@Controller('action-proposals')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  listProposals(
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, string>,
  ) {
    const parsed = ListProposalsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.suggestions.listProposals(extractUserId(headers), parsed.data);
  }

  @Get('pending-count')
  countPending(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId?: string,
  ) {
    return portfolioId
      ? this.suggestions.countPending(extractUserId(headers), portfolioId)
      : this.suggestions.countPending(extractUserId(headers));
  }

  @Get(':id')
  getProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.suggestions.getProposal(id, extractUserId(headers));
  }

  @Get(':id/audit')
  getProposalAudit(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.suggestions.getProposalAudit(id, extractUserId(headers));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approveProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = ApproveProposalSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.suggestions.approveProposal(id, extractUserId(headers), parsed.data);
  }

  @Post(':id/reject')
  @HttpCode(200)
  rejectProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = RejectProposalSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.suggestions.rejectProposal(id, extractUserId(headers), parsed.data);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancelProposal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = CancelProposalSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.suggestions.cancelProposal(id, extractUserId(headers), parsed.data);
  }
}
