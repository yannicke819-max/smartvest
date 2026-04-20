import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { TransfersService } from './services/transfers.service';
import { FundingAccountsService } from './services/funding-accounts.service';
import {
  CreateTransferSchema,
  UpdateTransferSchema,
  ListTransfersQuerySchema,
  SettleTransferSchema,
  CancelTransferSchema,
  FailTransferSchema,
  ReverseTransferSchema,
  CreateFundingSourceSchema,
  CreateFundingDestinationSchema,
} from './dto/funding.dto';

function extractUserId(headers: Record<string, string>): string {
  return headers['x-user-id'] ?? 'demo-user';
}

function parse<T>(schema: { safeParse: (x: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({ message: 'Validation échouée', issues: r.error?.issues });
  }
  return r.data as T;
}

@Controller('funding')
export class FundingController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly accounts: FundingAccountsService,
  ) {}

  // ------------------- Sources -------------------
  @Get('sources')
  listSources(@Headers() headers: Record<string, string>) {
    return this.accounts.listSources(extractUserId(headers));
  }

  @Post('sources')
  createSource(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    const dto = parse(CreateFundingSourceSchema, body);
    return this.accounts.createSource(extractUserId(headers), dto);
  }

  // ------------------- Destinations -------------------
  @Get('destinations')
  listDestinations(@Headers() headers: Record<string, string>) {
    return this.accounts.listDestinations(extractUserId(headers));
  }

  @Post('destinations')
  createDestination(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    const dto = parse(CreateFundingDestinationSchema, body);
    return this.accounts.createDestination(extractUserId(headers), dto);
  }

  // ------------------- Transfers -------------------
  @Get('transfers')
  listTransfers(@Headers() headers: Record<string, string>, @Query() query: unknown) {
    const dto = parse(ListTransfersQuerySchema, query);
    return this.transfers.list(extractUserId(headers), dto);
  }

  @Get('transfers/:id')
  getTransfer(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.transfers.get(id, extractUserId(headers));
  }

  @Post('transfers')
  createTransfer(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    const dto = parse(CreateTransferSchema, body);
    return this.transfers.create(extractUserId(headers), dto);
  }

  @Patch('transfers/:id')
  updateTransfer(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(UpdateTransferSchema, body);
    return this.transfers.update(id, extractUserId(headers), dto);
  }

  @Post('transfers/:id/initiate')
  @HttpCode(200)
  initiate(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.transfers.initiate(id, extractUserId(headers));
  }

  @Post('transfers/:id/settle')
  @HttpCode(200)
  settle(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(SettleTransferSchema, body ?? {});
    return this.transfers.settle(id, extractUserId(headers), dto);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  cancel(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(CancelTransferSchema, body ?? {});
    return this.transfers.cancel(id, extractUserId(headers), dto);
  }

  @Post('transfers/:id/fail')
  @HttpCode(200)
  fail(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(FailTransferSchema, body);
    return this.transfers.fail(id, extractUserId(headers), dto);
  }

  @Post('transfers/:id/reverse')
  @HttpCode(200)
  reverse(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dto = parse(ReverseTransferSchema, body);
    return this.transfers.reverse(id, extractUserId(headers), dto);
  }

  @Get('transfers/:id/audit')
  listAudit(@Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.transfers.listAudit(id, extractUserId(headers));
  }
}
