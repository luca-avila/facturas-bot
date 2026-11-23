import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Photo } from './photo.js';
import { UploadsConfig } from './uploads.config.js';

/**
 * The only code that touches `UPLOAD_DIR`. Paths are built only from a
 * `storage_key` this class generated, which a `CHECK` limits to
 * `<uuid>.<jpg|png|webp>`. Bytes are written as they arrive (E5).
 */
@Injectable()
export class ImageStore {
  constructor(private readonly config: UploadsConfig) {}

  newKey(extension: Photo['extension']): string {
    return `${randomUUID()}.${extension}`;
  }

  /** Never overwrites (`wx`), and the bytes are on disk before it returns. */
  async write(key: string, bytes: Buffer): Promise<void> {
    const file = await open(path.join(this.config.dir, key), 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  read(key: string): Promise<Buffer> {
    return readFile(path.join(this.config.dir, key));
  }
}
