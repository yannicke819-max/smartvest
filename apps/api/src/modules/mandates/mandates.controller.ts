import {
  Controller, Get, Post, Patch, Param, Body, Query, Headers, HttpCode,
} from '@nestjs/common';
import { MandatesService } from './services/mandates.service';
import { MandateGuardrailService } from './services/mandate-guardrail.service';

function extractUserId(headers: Record<string, string>): string {
  return headers['x-user-id'] ?? 'demo-user';
}

@Controller('mandates')
export class MandatesController {
  constructor(
    private readonly mandates: MandatesService,
    private readonly guardrail: MandateGuardrailService,
  ) {}

  @Get()
  listMandates(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId?: string,
  ) {
    const userId = extractUserId(headers);
    return portfolioId
      ? this.mandates.listMandates(userId, portfolioId)
      : this.mandates.listMandates(userId);
  }

  @Post()
  createMandate(
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ) {
    const dto = this.guardrail.validateCreate(body);
    return this.mandates.createMandate(extractUserId(headers), dto);
  }

  @Post('kill-all')
  @HttpCode(200)
  killAll(
    @Headers() headers: Record<string, string>,
    @Body('reason') reason?: string,
  ) {
    return mandateReason(reason)
      ? this.mandates.killAll(extractUserId(headers), reason)
      : this.mandates.killAll(extractUserId(headers));
  }

  @Get('audit')
  getAuditEvents(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId: string,
    @Query('mandateId') mandateId?: string,
  ) {
    const userId = extractUserId(headers);
    return mandateId
      ? this.mandates.getAuditEvents(portfolioId, userId, mandateId)
      : this.mandates.getAuditEvents(portfolioId, userId);
  }

  @Get(':id')
  getMandate(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.mandates.getMandate(id, extractUserId(headers));
  }

  @Patch(':id')
  updateMandate(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = this.guardrail.validateUpdate(body);
    return this.mandates.updateMandate(id, extractUserId(headers), dto);
  }

  @Post(':id/activate')
  @HttpCode(200)
  activateMandate(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.mandates.activateMandate(id, extractUserId(headers));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspendMandate(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return mandateReason(reason)
      ? this.mandates.suspendMandate(id, extractUserId(headers), reason)
      : this.mandates.suspendMandate(id, extractUserId(headers));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revokeMandate(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return mandateReason(reason)
      ? this.mandates.revokeMandate(id, extractUserId(headers), reason)
      : this.mandates.revokeMandate(id, extractUserId(headers));
  }

  @Post(':id/kill-switch')
  @HttpCode(200)
  killSwitch(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('activate') activate: boolean,
    @Body('reason') reason?: string,
  ) {
    return mandateReason(reason)
      ? this.mandates.toggleKillSwitch(id, extractUserId(headers), activate, reason)
      : this.mandates.toggleKillSwitch(id, extractUserId(headers), activate);
  }
}

function mandateReason(r: string | undefined): r is string {
  return typeof r === 'string' && r.length > 0;
}
