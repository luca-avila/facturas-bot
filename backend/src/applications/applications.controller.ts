import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApplicationsService } from './applications.service.js';
import type { Split } from './applications.types.js';
import { parseSplitRequest } from './split-input.js';

@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown): Promise<Split> {
    return this.applications.preview(parseSplitRequest(body));
  }
}
