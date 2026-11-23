import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/**
 * Wiring shared by `main.ts` and the tests. The app must be created with
 * `bodyParser: false`: only JSON bodies are parsed, so a cross-site form or
 * `text/plain` POST arrives with no body and fails validation.
 *
 * `POST /api/uploads` is the one route that parses multipart, through its own
 * `FilesInterceptor`. The global `SessionGuard` and its `UploadRequestGuard`
 * run before that parser, and a cross-site form can't send the
 * `X-Requested-With` header the guard requires.
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  app.useBodyParser('json');
  app.use(cookieParser());
}
