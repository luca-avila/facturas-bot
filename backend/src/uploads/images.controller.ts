import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { UploadsService } from './uploads.service.js';

@Controller('images')
export class ImagesController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * The bytes exactly as stored. No copy stays in a shared phone's cache,
   * and the bytes can never run as a page.
   */
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  )
  async image(@Param('id') id: string): Promise<StreamableFile> {
    const { bytes, mimeType } = await this.uploads.readImage(id);
    return new StreamableFile(bytes, {
      type: mimeType,
      length: bytes.length,
    });
  }
}
