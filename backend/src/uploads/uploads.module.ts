import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ImageStore } from './image-store.js';
import { UploadsConfig } from './uploads.config.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [AuditModule],
  controllers: [UploadsController],
  providers: [UploadsConfig, ImageStore, UploadsService],
})
export class UploadsModule {}
