import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { parseDocumentInput } from './document-input.js';
import { DocumentsService } from './documents.service.js';

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

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.documents.delete(id, user);
  }
}
