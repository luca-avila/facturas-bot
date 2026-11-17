import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BalancesModule } from './balances/balances.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    AuthModule,
    AuditModule,
    BalancesModule,
    SuppliersModule,
  ],
})
export class AppModule {}
