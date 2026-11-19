import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [AuditModule, ApplicationsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
