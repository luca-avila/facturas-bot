import { Module } from '@nestjs/common';
import { BalancesService } from './balances.service.js';

@Module({
  providers: [BalancesService],
  exports: [BalancesService],
})
export class BalancesModule {}
