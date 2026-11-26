import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BalancesModule } from '../balances/balances.module.js';
import { DocumentsController } from './documents.controller.js';
import { ErrorDocumentsController } from './error-documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DuplicateNumberCheck } from './duplicate-number-check.js';
import { DuplicateSuspectedCheck } from './duplicate-suspected-check.js';

@Module({
  imports: [AuditModule, ApplicationsModule, BalancesModule],
  controllers: [DocumentsController, ErrorDocumentsController],
  providers: [DocumentsService, DuplicateNumberCheck, DuplicateSuspectedCheck],
  exports: [DuplicateNumberCheck, DuplicateSuspectedCheck],
})
export class DocumentsModule {}
