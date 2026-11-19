import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BalancesModule } from '../balances/balances.module.js';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';

@Module({
  imports: [AuditModule, BalancesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
