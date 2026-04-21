import {
  Controller, Get, Post, Patch, Delete, Param, Body, Headers, BadRequestException,
} from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { BrokersService } from './services/brokers.service';
import { BrokerSyncService } from './services/broker-sync.service';
import { CreateConnectionSchema, UpdateConnectionSchema } from './dto/brokers.dto';

function extractUserId(headers: Record<string, string>): string {
  const id = headers['x-user-id'];
  if (!id) throw new UnauthorizedException('x-user-id header manquant');
  return id;
}

function parse<T>(
  schema: { safeParse: (x: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } } },
  body: unknown,
): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({ message: 'Validation échouée', issues: r.error?.issues });
  }
  return r.data as T;
}

@Controller('brokers')
export class BrokersController {
  constructor(
    private readonly brokers: BrokersService,
    private readonly sync: BrokerSyncService,
  ) {}

  @Get('connections')
  list(@Headers() headers: Record<string, string>) {
    return this.brokers.list(extractUserId(headers));
  }

  @Get('connections/:id')
  get(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.brokers.get(id, extractUserId(headers));
  }

  @Post('connections')
  create(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    const dto = parse(CreateConnectionSchema, body);
    return this.brokers.create(extractUserId(headers), dto);
  }

  @Patch('connections/:id')
  update(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(UpdateConnectionSchema, body);
    return this.brokers.update(id, extractUserId(headers), dto);
  }

  @Delete('connections/:id')
  revoke(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.brokers.revoke(id, extractUserId(headers));
  }

  @Post('connections/:id/test')
  test(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.brokers.test(id, extractUserId(headers));
  }

  @Post('connections/:id/sync')
  async runSync(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.sync.run(id, extractUserId(headers));
  }

  @Get('connections/:id/accounts')
  listAccounts(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.brokers.listAccounts(id, extractUserId(headers));
  }

  @Get('connections/:id/jobs')
  listJobs(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.sync.listJobs(id, extractUserId(headers));
  }

  @Get('connections/:id/audit')
  listAudit(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.brokers.listAudit(id, extractUserId(headers));
  }
}
