import { Controller, Get } from '@nestjs/common';
import { BalancesService } from '../balances/balances.service.js';
import type { ErrorDocumentList } from '../balances/balances.types.js';

/** *A resolver*. Behind the global `SessionGuard` like every route. */
@Controller('error-documents')
export class ErrorDocumentsController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  list(): Promise<ErrorDocumentList> {
    return this.balances.errorDocuments();
  }
}
