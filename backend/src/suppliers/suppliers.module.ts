import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BalancesModule } from '../balances/balances.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({
  imports: [AuditModule, BalancesModule, DocumentsModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
})
export class SuppliersModule {}
