import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExtractionModule } from './extraction.module.js';

@Module({
  imports: [PrismaModule, ExtractionModule],
})
export class WorkerModule {}
