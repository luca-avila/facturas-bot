/**
 * Fails when a file git would commit holds a valid CUIT that isn't in
 * TEST_CUITS, or isn't UTF-8 text the check can read. Runs in CI and as part
 * of `npm run lint`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_CUITS } from '../test/test-cuits.js';
import { checkFile } from './find-cuits.js';

/**
 * Files that aren't UTF-8 text, let in on purpose. Each is a path from the
 * repo root, and a person checked it holds no real data. Supplier documents
 * and spreadsheets never go here.
 */
const UNSCANNED_FILES: readonly string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readIfFile(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Deleted from the working tree, or a directory such as a submodule.
    if (code === 'ENOENT' || code === 'EISDIR') return undefined;
    throw error;
  }
}

function main(): number {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  // Tracked files plus untracked ones that aren't ignored, so a new file is
  // checked before its first commit.
  const files = new Set(
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
      .split('\0')
      .filter(Boolean),
  );

  let cuits = 0;
  let unreadable = 0;
  for (const file of files) {
    const content = readIfFile(path.join(root, file));
    if (content === undefined) continue;
    const result = checkFile(file, content, { cuits: TEST_CUITS, unscannedFiles: UNSCANNED_FILES });
    if (result.unreadable) {
      console.error(`${file}  not UTF-8 text, so it can't be scanned`);
      unreadable++;
    }
    for (const finding of result.findings) {
      console.error(`${file}:${finding.line}:${finding.column}  ${finding.masked}`);
      cuits++;
    }
  }

  if (cuits > 0) {
    console.error(
      `\nFound ${cuits} valid CUIT(s) that aren't test CUITs. The repo is public: ` +
        'use one from backend/test/test-cuits.ts instead.',
    );
  }
  if (unreadable > 0) {
    console.error(
      `\nFound ${unreadable} file(s) the check can't read. The repo is public, and real ` +
        "supplier documents never go in it. If a file holds no real data, add it to " +
        'UNSCANNED_FILES in backend/scripts/check-cuits.ts.',
    );
  }
  if (cuits > 0 || unreadable > 0) return 1;
  console.log(`CUIT check passed: ${files.size} files scanned.`);
  return 0;
}

process.exitCode = main();
