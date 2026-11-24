import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';

const NOT_OUTSIDE_REPO =
  'UPLOAD_DIR must be set to an absolute path outside the repo, ' +
  'such as /home/you/facturas-uploads. Put it in .env.';

/**
 * Read from `process.env` when the app is created, not when this file is
 * imported, so a missing `UPLOAD_DIR` stops the backend from starting.
 */
@Injectable()
export class UploadsConfig {
  /** Absolute, outside the repo, and created at mode 0700 if it didn't exist. */
  readonly dir: string;

  constructor() {
    const repoRoot = findRepoRoot();
    const dir = process.env.UPLOAD_DIR ?? '';
    if (!path.isAbsolute(dir)) throw new Error(NOT_OUTSIDE_REPO);
    // Inside the repo, the Vite dev server (`--host`) could serve the photos
    // to the local network. Checked before creating it, and again on the real
    // path so a symlink into the repo can't slip through.
    if (repoRoot && isInside(path.resolve(dir), path.resolve(repoRoot))) {
      throw new Error(NOT_OUTSIDE_REPO);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (repoRoot && isInside(realpathSync(dir), realpathSync(repoRoot))) {
      throw new Error(NOT_OUTSIDE_REPO);
    }
    this.dir = dir;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** The nearest folder above this file with a `.git`, or null outside a checkout. */
function findRepoRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
