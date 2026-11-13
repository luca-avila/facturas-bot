import { isUtf8 } from 'node:buffer';
import { isValidCuit } from '../src/common/cuit.js';

export interface CuitFinding {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Never the full number: logs on a public repo are public. */
  masked: string;
}

/**
 * 11 digits, optionally with a dash after the 2nd digit and before the last,
 * not preceded or followed by another digit. Letters around it don't matter.
 */
const CANDIDATE = /(?<![0-9])([0-9]{2})-?([0-9]{8})-?([0-9])(?![0-9])/g;

/** Finds valid CUITs in `text` that aren't in `allowlist`. */
export function findCuits(text: string, allowlist: Iterable<string>): CuitFinding[] {
  const allowed = new Set(allowlist);
  const findings: CuitFinding[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const digits = match[1] + match[2] + match[3];
    if (!isValidCuit(digits) || allowed.has(digits)) continue;
    const before = text.slice(0, match.index);
    const lineStart = before.lastIndexOf('\n') + 1;
    findings.push({
      line: before.split('\n').length,
      column: match.index - lineStart + 1,
      masked: mask(digits),
    });
  }
  return findings;
}

function mask(digits: string): string {
  return `${digits.slice(0, 2)}-********-*`;
}

export interface FileCheck {
  /**
   * The file isn't UTF-8 text, so the check can't see inside it, and it isn't
   * on `unscannedFiles`.
   */
  unreadable: boolean;
  findings: CuitFinding[];
}

/**
 * Checks one file. Binaries, compressed formats such as xlsx or pdf, and
 * UTF-16 can hide a CUIT from the scan, so they fail unless `unscannedFiles`
 * lists their path.
 */
export function checkFile(
  file: string,
  content: Buffer,
  allowlists: { cuits: Iterable<string>; unscannedFiles: Iterable<string> },
): FileCheck {
  // ASCII in UTF-16 is valid UTF-8, but with a NUL after every character.
  if (content.includes(0) || !isUtf8(content)) {
    return { unreadable: !new Set(allowlists.unscannedFiles).has(file), findings: [] };
  }
  return { unreadable: false, findings: findCuits(content.toString('utf8'), allowlists.cuits) };
}
