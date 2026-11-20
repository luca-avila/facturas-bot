import { Module } from '@nestjs/common';
import { ImageStore } from './image-store.js';
import { UploadsConfig } from './uploads.config.js';

@Module({
  providers: [UploadsConfig, ImageStore],
})
export class UploadsModule {}
