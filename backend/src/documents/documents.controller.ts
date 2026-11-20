import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { parseDocumentInput } from './document-input.js';
import { type DocumentDetail, DocumentsService } from './documents.service.js';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  create(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string }> {
    return this.documents.createManual(parseDocumentInput(body), user);
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<DocumentDetail> {
    const doc = await this.documents.detail(id);
    if (doc === null) throw new NotFoundException();
    return doc;
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.delete(id, user);
  }
}
