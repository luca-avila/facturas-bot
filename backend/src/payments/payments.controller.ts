import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { BalancesService } from '../balances/balances.service.js';
import type { PaymentDetail, PaymentList } from '../balances/balances.types.js';
import { invalidRequest } from '../common/field-errors.js';
import { isUuid } from '../common/uuid.js';
import { parseMarkPaidInput, parsePaymentInput } from './payment-input.js';
import { PaymentsService } from './payments.service.js';

/** `?supplierId=`. A repeated parameter arrives as an array, and is malformed. */
function parseListQuery(query: Record<string, unknown>): {
  supplierId: string | null;
} {
  const { supplierId } = query;
  if (supplierId === undefined) return { supplierId: null };
  if (typeof supplierId !== 'string' || !isUuid(supplierId)) {
    throw invalidRequest();
  }
  return { supplierId };
}

@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly balances: BalancesService,
  ) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<PaymentList> {
    return this.balances.listPayments(parseListQuery(query));
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<PaymentDetail> {
    const payment = await this.balances.payment(id);
    if (payment === null) throw new NotFoundException();
    return payment;
  }

  @Post()
  create(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string }> {
    return this.payments.create(parsePaymentInput(body), user);
  }

  @Post('mark-paid')
  markPaid(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string }> {
    return this.payments.markPaid(parseMarkPaidInput(body), user);
  }
}
