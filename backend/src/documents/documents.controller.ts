import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import {
  parseDocumentInput,
  parseUpdateDocumentInput,
} from './document-input.js';
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

  @Put(':id')
  @HttpCode(204)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.update(id, parseUpdateDocumentInput(body), user);
  }

  @Post(':id/review')
  @HttpCode(204)
  async review(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.review(id, user);
  }

  @Post(':id/retry')
  @HttpCode(204)
  async retry(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.retry(id, user);
  }

  @Post(':id/issues/:code/accept')
  @HttpCode(204)
  async acceptIssue(
    @Param('id') id: string,
    @Param('code') code: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.acceptIssue(id, code, user);
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
