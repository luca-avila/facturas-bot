import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Loads the repo-root `.env` (shared with `docker compose`). A missing file
 * isn't an error, and variables already set in the environment win.
 */
export function loadRootEnv(): void {
  const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  dotenv.config({ path: path.resolve(backendDir, '..', '.env'), quiet: true });
}
