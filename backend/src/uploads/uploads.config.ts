import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';

/**
 * Read from `process.env` when the app is created, not when this file is
 * imported, so a missing `UPLOAD_DIR` stops the backend from starting.
 */
@Injectable()
export class UploadsConfig {
  /** Absolute, and created at mode 0700 if it didn't exist. */
  readonly dir: string;

  constructor() {
    const dir = process.env.UPLOAD_DIR ?? '';
    if (!path.isAbsolute(dir)) {
      throw new Error(
        'UPLOAD_DIR must be set to an absolute path outside the repo, ' +
          'such as /home/you/facturas-uploads. Put it in .env.',
      );
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
  }
}
