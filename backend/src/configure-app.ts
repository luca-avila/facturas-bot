import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/**
 * Wiring shared by `main.ts` and the tests. The app must be created with
 * `bodyParser: false`: only JSON bodies are parsed, so a cross-site form or
 * `text/plain` POST arrives with no body and fails validation.
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  app.useBodyParser('json');
  app.use(cookieParser());
}
