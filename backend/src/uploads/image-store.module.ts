import { Module } from '@nestjs/common';
import { ImageStore } from './image-store.js';
import { UploadsConfig } from './uploads.config.js';

/**
 * `ImageStore` and its config, shared by the backend's uploads and the
 * worker. `ImageStore` is still the only code that touches `UPLOAD_DIR`.
 */
@Module({
  providers: [UploadsConfig, ImageStore],
  exports: [UploadsConfig, ImageStore],
})
export class ImageStoreModule {}
