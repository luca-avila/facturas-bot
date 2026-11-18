import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BalancesModule } from '../balances/balances.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [AuditModule, ApplicationsModule, BalancesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
