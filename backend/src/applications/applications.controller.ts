import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { ApplicationsService } from './applications.service.js';
import type { Split } from './applications.types.js';
import { parseApplyCreditInput, parseSplitRequest } from './split-input.js';

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown): Promise<Split> {
    return this.applications.preview(parseSplitRequest(body));
  }

  @Post()
  @HttpCode(204)
  async apply(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.applications.applyCredit(parseApplyCreditInput(body), user);
  }
}
