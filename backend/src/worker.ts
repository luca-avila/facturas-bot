/**
 * The extraction worker's own process: a Nest application context with no
 * HTTP server. It sends every queued upload in its database to Anthropic.
 */
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { loadRootEnv } from './env.js';
import { ExtractionWorker } from './extraction/extraction-worker.js';
import { WorkerModule } from './extraction/worker.module.js';

loadRootEnv();

async function main(): Promise<number> {
  let app: INestApplicationContext;
  try {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      abortOnError: false,
      logger: ['error', 'warn', 'log'],
    });
  } catch (error) {
    // A config error names the variable, never its value.
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // A call in flight finishes first. One abandoned by a kill is picked up
  // again when its lease expires.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  await app.get(ExtractionWorker).run(controller.signal);
  await app.close();
  return 0;
}

process.exitCode = await main();
