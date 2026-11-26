import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { SessionUser } from '../auth/session.js';
import { BalancesService } from '../balances/balances.service.js';
import {
  SUPPLIER_SORTS,
  type SupplierAccount,
  type SupplierList,
  type SupplierSort,
} from '../balances/balances.types.js';
import { invalidRequest } from '../common/field-errors.js';
import { parseSupplierInput, parseTermInput } from './supplier-input.js';
import { SuppliersService, type TermPreview } from './suppliers.service.js';

function isSupplierSort(value: string): value is SupplierSort {
  return (SUPPLIER_SORTS as readonly string[]).includes(value);
}

/** `?q=&sort=`. A repeated parameter arrives as an array, and is malformed. */
function parseListQuery(query: Record<string, unknown>): {
  q: string;
  sort: SupplierSort;
} {
  const { q = '', sort = 'overdue' } = query;
  if (
    typeof q !== 'string' ||
    typeof sort !== 'string' ||
    !isSupplierSort(sort)
  ) {
    throw invalidRequest();
  }
  return { q, sort };
}

@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly balances: BalancesService,
  ) {}

  @Get()
  list(@Query() query: Record<string, unknown>): Promise<SupplierList> {
    return this.balances.listSuppliers(parseListQuery(query));
  }

  @Get(':id')
  async account(@Param('id') id: string): Promise<SupplierAccount> {
    const account = await this.balances.supplierAccount(id);
    if (account === null) throw new NotFoundException();
    return account;
  }

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

  @Post(':id/term/preview')
  @HttpCode(200)
  previewTerm(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TermPreview> {
    return this.suppliers.previewTerm(id, parseTermInput(body));
  }

  @Post(':id/term')
  @HttpCode(200)
  setTerm(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ): Promise<TermPreview> {
    return this.suppliers.setTerm(id, parseTermInput(body), user);
  }
}
