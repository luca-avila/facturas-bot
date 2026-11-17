import { Body, Controller, HttpCode, Param, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { parseSupplierInput } from './supplier-input.js';
import { SuppliersService } from './suppliers.service.js';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Post()
  create(
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<{ id: string }> {
    return this.suppliers.create(parseSupplierInput(body), user);
  }

  @Put(':id')
  @HttpCode(204)
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<void> {
    await this.suppliers.update(id, parseSupplierInput(body), user);
  }
}
