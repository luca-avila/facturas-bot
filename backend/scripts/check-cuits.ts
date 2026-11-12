/**
 * Fails when a file git would commit holds a valid CUIT that isn't in
 * TEST_CUITS. Runs in CI and as part of `npm run lint`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_CUITS } from '../test/test-cuits.js';
import { findCuits } from './find-cuits.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readIfFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
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

  let count = 0;
  for (const file of files) {
    const text = readIfFile(path.join(root, file));
    if (text === undefined) continue;
    for (const finding of findCuits(text, TEST_CUITS)) {
      console.error(`${file}:${finding.line}:${finding.column}  ${finding.masked}`);
      count++;
    }
  }

  if (count > 0) {
    console.error(
      `\nFound ${count} valid CUIT(s) that aren't test CUITs. The repo is public: ` +
        'use one from backend/test/test-cuits.ts instead.',
    );
    return 1;
  }
  console.log(`CUIT check passed: ${files.size} files scanned.`);
  return 0;
}

process.exitCode = main();
