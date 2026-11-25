import { Module } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { AuditModule } from '../audit/audit.module.js';
import { ImageStoreModule } from '../uploads/image-store.module.js';
import {
  ANTHROPIC_CLIENT,
  createAnthropicClient,
  LLM_FETCH,
  type LlmFetch,
} from './anthropic-client.js';
import { ExtractionCall } from './extraction-call.js';
import { DuplicateNumberCheck } from './duplicate-number-check.js';
import { ExtractionConfig } from './extraction-config.js';
import { ExtractionWorker } from './extraction-worker.js';
import { ExtractionWriter } from './extraction-writer.js';

/** The worker's module. `AppModule` never imports it, so the backend can't call the LLM. */
@Module({
  imports: [AuditModule, ImageStoreModule],
  providers: [
    ExtractionConfig,
    { provide: LLM_FETCH, useFactory: (): LlmFetch => globalThis.fetch },
    {
      provide: ANTHROPIC_CLIENT,
      useFactory: (config: ExtractionConfig, fetch: LlmFetch) =>
        createAnthropicClient({ apiKey: config.apiKey, fetch }),
      inject: [ExtractionConfig, LLM_FETCH],
    },
    {
      provide: ExtractionCall,
      useFactory: (client: Anthropic, config: ExtractionConfig) =>
        new ExtractionCall(client, config.model),
      inject: [ANTHROPIC_CLIENT, ExtractionConfig],
    },
    DuplicateNumberCheck,
    ExtractionWriter,
    ExtractionWorker,
  ],
  exports: [ExtractionWorker],
})
export class ExtractionModule {}
