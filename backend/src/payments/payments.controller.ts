import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { parsePaymentInput } from './payment-input.js';
import { PaymentsService } from './payments.service.js';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string }> {
    return this.payments.create(parsePaymentInput(body), user);
  }
}
