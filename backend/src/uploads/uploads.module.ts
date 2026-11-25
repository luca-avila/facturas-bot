import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ImageStoreModule } from './image-store.module.js';
import { ImagesController } from './images.controller.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [AuditModule, ImageStoreModule],
  controllers: [UploadsController, ImagesController],
  providers: [UploadsService],
})
export class UploadsModule {}
