import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { loadRootEnv } from './env.js';

loadRootEnv();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
