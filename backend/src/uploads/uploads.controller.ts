import {
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { invalidRequest } from '../common/field-errors.js';
import { MAX_PAGES, MAX_PHOTO_BYTES } from './photo.js';
import { UploadRequestGuard } from './upload-request.guard.js';
import {
  type UploadedPhoto,
  type UploadResult,
  UploadsService,
} from './uploads.service.js';
import type { UploadList, UploadScope } from './uploads.types.js';

/** `?scope=mine|all`, required. A repeated parameter arrives as an array, and is malformed. */
function parseScope(query: Record<string, unknown>): UploadScope {
  const { scope } = query;
  if (scope !== 'mine' && scope !== 'all') throw invalidRequest();
  return scope;
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Get()
  list(
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: SessionUser,
  ): Promise<UploadList> {
    return this.uploads.list(parseScope(query), user);
  }

  /**
   * 201 for a new document, 200 for one that already holds every photo.
   * The global `SessionGuard`, then `UploadRequestGuard`, run before multer,
   * which keeps files in memory (no `storage`, no `dest`).
   */
  @Post()
  @UseGuards(UploadRequestGuard)
  @UseInterceptors(
    FilesInterceptor('photos', MAX_PAGES, {
      limits: {
        fileSize: MAX_PHOTO_BYTES,
        files: MAX_PAGES,
        fields: 0,
        parts: MAX_PAGES,
      },
    }),
  )
  async upload(
    @UploadedFiles() files: UploadedPhoto[] | undefined,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadResult> {
    const result = await this.uploads.upload(files, user);
    if (result.alreadyUploaded) res.status(200);
    return result;
  }
}
