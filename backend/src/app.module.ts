import { Module } from '@nestjs/common';
import { ApplicationsModule } from './applications/applications.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BalancesModule } from './balances/balances.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    AuthModule,
    AuditModule,
    BalancesModule,
    SuppliersModule,
    DocumentsModule,
    ApplicationsModule,
    PaymentsModule,
    UploadsModule,
  ],
})
export class AppModule {}
