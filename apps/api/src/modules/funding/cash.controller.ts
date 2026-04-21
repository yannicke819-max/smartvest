import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { extractUserId } from '../../common/extract-user-id';
import { CashBalancesService } from './services/cash-balances.service';
import { CashReservationsService } from './services/cash-reservations.service';
import {
  CreateReservationSchema,
  ListLedgerQuerySchema,
  ListReservationsQuerySchema,
} from './dto/cash.dto';


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

@Controller('cash')
export class CashController {
  constructor(
    private readonly balances: CashBalancesService,
    private readonly reservations: CashReservationsService,
  ) {}

  // ------------------- Balances -------------------
  @Get('balances')
  listBalances(@Headers() headers: Record<string, string>) {
    return this.balances.listForUser(extractUserId(headers));
  }

  @Get('balances/summary')
  summary(@Headers() headers: Record<string, string>) {
    return this.balances.summary(extractUserId(headers));
  }

  @Get('balances/:destinationId')
  getForDestination(
    @Headers() headers: Record<string, string>,
    @Param('destinationId') destinationId: string,
    @Query('currency') currency?: string,
  ) {
    return this.balances.getForDestination(destinationId, extractUserId(headers), currency);
  }

  // ------------------- Ledger -------------------
  @Get('ledger')
  ledger(@Headers() headers: Record<string, string>, @Query() query: unknown) {
    const dto = parse(ListLedgerQuerySchema, query);
    return this.balances.listLedger(extractUserId(headers), dto);
  }

  // ------------------- Reservations -------------------
  @Get('reservations')
  listReservations(@Headers() headers: Record<string, string>, @Query() query: unknown) {
    const dto = parse(ListReservationsQuerySchema, query);
    return this.reservations.list(extractUserId(headers), dto);
  }

  @Post('reservations')
  createReservation(@Headers() headers: Record<string, string>, @Body() body: unknown) {
    const dto = parse(CreateReservationSchema, body);
    return this.reservations.create(extractUserId(headers), dto);
  }

  @Post('reservations/:id/release')
  @HttpCode(200)
  releaseReservation(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.reservations.release(id, extractUserId(headers));
  }
}
