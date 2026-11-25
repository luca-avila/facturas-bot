import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { LLM_FETCH } from '../src/extraction/anthropic-client.js';
import { ExtractionWorker } from '../src/extraction/extraction-worker.js';
import { WorkerModule } from '../src/extraction/worker.module.js';
import type { FakeLlm } from './fake-llm.js';

/**
 * The real `WorkerModule`, with `fetch` going to `fakeLlm`. `override` can
 * replace another provider, such as `DuplicateNumberCheck`.
 */
export async function createTestWorker(
  fakeLlm: FakeLlm,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<{ worker: ExtractionWorker; close: () => Promise<void> }> {
  const moduleRef = await override(
    Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(LLM_FETCH)
      .useValue(fakeLlm.fetch),
  ).compile();
  await moduleRef.init();
  return {
    worker: moduleRef.get(ExtractionWorker),
    close: () => moduleRef.close(),
  };
}
