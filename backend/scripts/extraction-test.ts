/**
 * The extraction test (the gate). Sends every sample in `samples/` to the
 * model at every effort level, with the same request the worker sends, and
 * judges what comes back. It saves nothing, and prints values from the
 * samples only with `--values`.
 *
 *   npm run extraction:test                 every level
 *   npm run extraction:test -- --effort=low one level
 *   npm run extraction:test -- --values     also print expected and read values
 *
 * Exits 1 when no level passes every sample, or when a 1650×2200 image costs
 * 4,784 tokens or more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { Decimal } from 'decimal.js';
import { isValidCuit } from '../src/common/cuit.js';
import { isIsoDate } from '../src/common/dates.js';
import { Money } from '../src/common/money.js';
import { normalizeNumber } from '../src/documents/document-number.js';
import { loadRootEnv } from '../src/env.js';
import { createAnthropicClient } from '../src/extraction/anthropic-client.js';
import {
  type CallOutcome,
  ExtractionCall,
} from '../src/extraction/extraction-call.js';
import type { PageImage } from '../src/extraction/extraction-request.js';
import {
  type ExtractionEffort,
  type ExtractionOutput,
  PROMPT,
} from '../src/extraction/prompt.js';
import { mapExtraction } from '../src/extraction/extraction-mapping.js';
import { inspectPhoto } from '../src/uploads/photo.js';

const LEVELS: readonly ExtractionEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
/**
 * The levels a default run sends, and the only ones that can pass the gate.
 * `max` runs out of tokens on most samples, costs more and reads no better,
 * so it only runs with `--effort=max`.
 */
const GATED_LEVELS: readonly ExtractionEffort[] = LEVELS.filter(
  (level) => level !== 'max',
);
/** Haiku 5.5 reads up to this many visual tokens before it downscales. */
const MAX_IMAGE_TOKENS = 4_784;
const INPUT_USD_PER_MTOK = new Decimal('0.10');
const OUTPUT_USD_PER_MTOK = new Decimal('0.50');
const ONE_PESO = Money.fromString('1.00');

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const samplesDir = path.join(repoRoot, 'samples');

interface LabeledTax {
  kind: string;
  label: string;
  rate: string | null;
  base: string | null;
  amount: string;
}

interface Label {
  type: string;
  letter: string;
  number: string;
  issueDate: string;
  supplierCuit: string;
  supplierName: string;
  recipientCuit: string;
  subtotal: string;
  total: string;
  cae: string;
  printedDueDate: string | null;
  printedTermDays: number | null;
  taxes: LabeledTax[];
  lineCount: number;
  lineTotalSum: string;
}

type Verdict = 'pass' | 'fail' | 'skipped';

interface Check {
  name: string;
  verdict: Verdict;
  expected?: unknown;
  read?: unknown;
}

interface SampleRun {
  sample: string;
  level: ExtractionEffort;
  seconds: number;
  outcome: CallOutcome;
  checks: Check[];
  unsupportedLevel: boolean;
}

function money(value: string | null | undefined): Money | null {
  if (value === null || value === undefined) return null;
  try {
    return Money.fromString(value);
  } catch {
    return null;
  }
}

function equalMoney(a: string | null, b: string | null): boolean {
  const x = money(a);
  const y = money(b);
  return x !== null && y !== null && x.compare(y) === 0;
}

function within(a: Money, b: Money, tolerance: Money): boolean {
  const diff = a.subtract(b);
  return (
    diff.compare(tolerance) <= 0 &&
    Money.fromString('0.00').subtract(tolerance).compare(diff) <= 0
  );
}

function digits(value: string | null): string | null {
  return value === null ? null : value.replace(/[^0-9]/g, '');
}

function fold(text: string | null): string | null {
  return text === null
    ? null
    : text
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function equalDecimal(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return new Decimal(a).equals(new Decimal(b));
  } catch {
    return false;
  }
}

function check(
  name: string,
  pass: boolean,
  expected: unknown,
  read: unknown,
): Check {
  return { name, verdict: pass ? 'pass' : 'fail', expected, read };
}

function sum(values: (string | null)[]): Money | null {
  let total = Money.fromString('0.00');
  for (const value of values) {
    const amount = money(value);
    if (amount === null) return null;
    total = total.add(amount);
  }
  return total;
}

/** factura-a-01 against its hand-made label. */
function compareWithLabel(out: ExtractionOutput, label: Label): Check[] {
  const checks: Check[] = [
    check('type', out.type === label.type, label.type, out.type),
    check('letter', out.letter === label.letter, label.letter, out.letter),
    check(
      'issueDate',
      out.issueDate === label.issueDate,
      label.issueDate,
      out.issueDate,
    ),
    check(
      'printedDueDate',
      out.printedDueDate === label.printedDueDate,
      label.printedDueDate,
      out.printedDueDate,
    ),
    check(
      'number',
      out.number !== null &&
        normalizeNumber(out.number) === normalizeNumber(label.number),
      label.number,
      out.number,
    ),
    check(
      'supplierCuit',
      digits(out.supplierCuit) === digits(label.supplierCuit),
      label.supplierCuit,
      out.supplierCuit,
    ),
    check(
      'recipientCuit',
      digits(out.recipientCuit) === digits(label.recipientCuit),
      label.recipientCuit,
      out.recipientCuit,
    ),
    check('cae', digits(out.cae) === digits(label.cae), label.cae, out.cae),
    check(
      'supplierName',
      fold(out.supplierName) === fold(label.supplierName),
      label.supplierName,
      out.supplierName,
    ),
    check(
      'subtotal',
      equalMoney(out.subtotal, label.subtotal),
      label.subtotal,
      out.subtotal,
    ),
    check('total', equalMoney(out.total, label.total), label.total, out.total),
    check(
      'printedTermDays',
      out.printedTermDays === label.printedTermDays,
      label.printedTermDays,
      out.printedTermDays,
    ),
  ];

  const unmatched = [...out.taxes];
  const taxesMatch =
    out.taxes.length === label.taxes.length &&
    label.taxes.every((tax) => {
      const i = unmatched.findIndex(
        (read) =>
          read.kind === tax.kind &&
          equalMoney(read.amount, tax.amount) &&
          (tax.rate === null || equalDecimal(read.rate, tax.rate)) &&
          (tax.base === null || equalMoney(read.base, tax.base)),
      );
      if (i === -1) return false;
      unmatched.splice(i, 1);
      return true;
    });
  checks.push(check('taxes', taxesMatch, label.taxes, out.taxes));

  checks.push(
    check(
      'lineCount',
      out.lines.length === label.lineCount,
      label.lineCount,
      out.lines.length,
    ),
  );
  const lineSum = sum(out.lines.map((line) => line.lineTotal));
  checks.push(
    check(
      'lineTotalSum',
      lineSum !== null &&
        lineSum.compare(Money.fromString(label.lineTotalSum)) === 0,
      label.lineTotalSum,
      lineSum?.toString() ?? null,
    ),
  );
  return checks;
}

/** The other samples, judged by checks. `factura-a` is an invoice A, `remito-x` a delivery note X. */
function judgeByChecks(out: ExtractionOutput, sample: string): Check[] {
  const match = /^(factura|remito)-([a-z])-/.exec(sample);
  const expectedType =
    match?.[1] === 'factura'
      ? 'invoice'
      : match?.[1] === 'remito'
        ? 'delivery_note'
        : null;
  const expectedLetter = match?.[2].toUpperCase() ?? null;
  const supplierCuit = digits(out.supplierCuit);
  const recipientCuit = digits(out.recipientCuit);
  const checks: Check[] = [
    check('isDocument', out.isDocument, true, out.isDocument),
    check('type', out.type === expectedType, expectedType, out.type),
    check('letter', out.letter === expectedLetter, expectedLetter, out.letter),
    check(
      'supplierCuit',
      supplierCuit !== null &&
        isValidCuit(supplierCuit) &&
        supplierCuit !== recipientCuit,
      'valid, not the recipient',
      out.supplierCuit,
    ),
    check(
      'issueDate',
      out.issueDate !== null && isIsoDate(out.issueDate),
      'YYYY-MM-DD',
      out.issueDate,
    ),
    check(
      'total',
      money(out.total)?.isPositive() ?? false,
      'positive',
      out.total,
    ),
  ];

  const subtotal = money(out.subtotal);
  const total = money(out.total);
  // Summed the way the worker stores them: a tax with no readable amount or
  // label is dropped. A dropped row that had a real amount still shows, as a
  // sum that misses the total.
  const taxes = storedTaxes(out);
  const taxSum = sum(taxes.map((tax) => tax.amount));
  if (taxes.length === 0 || subtotal === null || total === null) {
    checks.push({ name: 'totalsAddUp', verdict: 'skipped' });
  } else {
    checks.push(
      check(
        'totalsAddUp',
        taxSum !== null && within(subtotal.add(taxSum), total, ONE_PESO),
        out.total,
        taxSum === null ? null : subtotal.add(taxSum).toString(),
      ),
    );
  }

  // Without every line total, the check has no inputs: a delivery note can
  // list items with no prices.
  if (
    out.lines.length === 0 ||
    out.lines.some((line) => line.lineTotal === null)
  ) {
    checks.push({ name: 'linesAddUp', verdict: 'skipped' });
  } else {
    const lineSum = sum(out.lines.map((line) => line.lineTotal));
    checks.push(
      check(
        'linesAddUp',
        lineSum !== null &&
          ((subtotal !== null && within(lineSum, subtotal, ONE_PESO)) ||
            (total !== null && within(lineSum, total, ONE_PESO))),
        { subtotal: out.subtotal, total: out.total },
        lineSum?.toString() ?? null,
      ),
    );
  }
  return checks;
}

/** The taxes the worker would store, through its own mapping. */
function storedTaxes(out: ExtractionOutput): { amount: string }[] {
  const mapped = mapExtraction(out);
  return mapped.kind === 'document' ? mapped.taxes : [];
}

function costUsd(inputTokens: number, outputTokens: number): Decimal {
  return new Decimal(inputTokens)
    .times(INPUT_USD_PER_MTOK)
    .plus(new Decimal(outputTokens).times(OUTPUT_USD_PER_MTOK))
    .dividedBy(1_000_000);
}

function u32be(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

/** A white RGB PNG. It holds no data from any sample. */
function whitePng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3, 0xff);
  row[0] = 0; // filter: none
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk(
      'IHDR',
      Buffer.concat([
        u32be(width),
        u32be(height),
        Buffer.from([8, 2, 0, 0, 0]),
      ]),
    ),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mark(verdict: Verdict): string {
  return verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '–';
}

function isUnsupportedLevel(outcome: CallOutcome): boolean {
  return !outcome.ok && outcome.error.startsWith('BadRequestError 400');
}

function samplePassed(run: SampleRun): boolean {
  return run.outcome.ok && run.checks.every((c) => c.verdict !== 'fail');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      effort: { type: 'string' },
      values: { type: 'boolean', default: false },
    },
  });
  const levels =
    values.effort === undefined
      ? GATED_LEVELS
      : LEVELS.filter((level) => level === values.effort);
  if (levels.length === 0) {
    console.error(`--effort must be one of ${LEVELS.join(', ')}.`);
    return 2;
  }

  loadRootEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const model = process.env.LLM_MODEL?.trim() ?? '';
  if (apiKey === '') {
    console.error('ANTHROPIC_API_KEY is not set in .env.');
    return 2;
  }
  if (model === '') {
    console.error('LLM_MODEL is not set in .env.');
    return 2;
  }

  const files = readdirSync(samplesDir)
    .filter((file) => file.endsWith('.jpeg'))
    .sort();
  const labels = JSON.parse(
    readFileSync(path.join(samplesDir, 'labels.json'), 'utf8'),
  ) as Record<string, Label>;
  const samples = files.map((file) => {
    const bytes = readFileSync(path.join(samplesDir, file));
    const photo = inspectPhoto(bytes);
    if (photo === null) throw new Error(`${file} isn't a JPEG, PNG or WebP.`);
    const page: PageImage = { mimeType: photo.mimeType, bytes };
    return { file, page };
  });

  const client = createAnthropicClient({ apiKey, fetch: globalThis.fetch });
  const call = new ExtractionCall(client, model);
  const runs: SampleRun[] = [];

  for (const level of levels) {
    for (const { file, page } of samples) {
      const start = performance.now();
      const outcome = await call.run([page], level);
      const seconds = (performance.now() - start) / 1000;
      const label = labels[file];
      const checks = !outcome.ok
        ? []
        : label === undefined
          ? judgeByChecks(outcome.output, file)
          : compareWithLabel(outcome.output, label);
      const run: SampleRun = {
        sample: file,
        level,
        seconds,
        outcome,
        checks,
        unsupportedLevel: isUnsupportedLevel(outcome),
      };
      runs.push(run);
      printRun(run, values.values);
    }
  }

  console.log('\nPer level:');
  let anyLevelPassed = false;
  for (const level of levels) {
    const levelRuns = runs.filter((run) => run.level === level);
    if (levelRuns.some((run) => run.unsupportedLevel)) {
      console.log(`  ${level}: unsupported (400)`);
      continue;
    }
    const passed = levelRuns.filter(samplePassed).length;
    const ok = levelRuns.flatMap((run) =>
      run.outcome.ok ? [run.outcome] : [],
    );
    const avg = (n: number) =>
      ok.length === 0
        ? '-'
        : new Decimal(n).dividedBy(ok.length).round().toString();
    const inTokens = ok.reduce((t, o) => t + o.usage.inputTokens, 0);
    const outTokens = ok.reduce((t, o) => t + o.usage.outputTokens, 0);
    const avgCost =
      ok.length === 0
        ? '-'
        : costUsd(inTokens, outTokens)
            .dividedBy(ok.length)
            .toSignificantDigits(3)
            .toString();
    console.log(
      `  ${level}: ${passed}/${levelRuns.length} samples passed, ` +
        `avg ${avg(inTokens)} in / ${avg(outTokens)} out tokens, US$ ${avgCost} per document`,
    );
    if (
      GATED_LEVELS.includes(level) &&
      passed === samples.length &&
      levelRuns.length === samples.length
    ) {
      anyLevelPassed = true;
    }
  }

  const textOnly = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  });
  const withImage = await client.messages.countTokens({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: whitePng(1650, 2200).toString('base64'),
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const imageTokens = withImage.input_tokens - textOnly.input_tokens;
  const imageOk = imageTokens < MAX_IMAGE_TOKENS;
  console.log(
    `\n1650×2200 image: ${imageTokens} tokens ${imageOk ? '✓' : '✗'} (must be under ${MAX_IMAGE_TOKENS})`,
  );

  if (!anyLevelPassed) console.log('No level passed every sample.');
  return anyLevelPassed && imageOk ? 0 : 1;
}

function printRun(run: SampleRun, showValues: boolean): void {
  const head = `${run.level.padEnd(6)} ${run.sample.padEnd(20)}`;
  const time = `${new Decimal(run.seconds).toDecimalPlaces(1).toString()} s`;
  if (!run.outcome.ok) {
    // The error names the class and status. Its message can quote what was
    // read, so it's only printed with --values.
    const [kind] = run.outcome.error.split(':');
    console.log(`${head} ✗ call failed: ${kind}  ${time}`);
    if (showValues) console.log(`    ${run.outcome.error}`);
    return;
  }
  const { inputTokens, outputTokens } = run.outcome.usage;
  const marks = run.checks
    .map((c) => `${mark(c.verdict)} ${c.name}`)
    .join('  ');
  console.log(
    `${head} ${samplePassed(run) ? 'PASS' : 'FAIL'}  ${marks}  ` +
      `${inputTokens} in / ${outputTokens} out  ` +
      `US$ ${costUsd(inputTokens, outputTokens).toSignificantDigits(3).toString()}  ${time}`,
  );
  if (showValues) {
    for (const tax of run.outcome.output.taxes) {
      console.log(`    tax row: ${JSON.stringify(tax)}`);
    }
    for (const c of run.checks) {
      if (c.verdict === 'skipped') continue;
      console.log(
        `    ${mark(c.verdict)} ${c.name}: expected ${JSON.stringify(c.expected)}, read ${JSON.stringify(c.read)}`,
      );
    }
  }
}

process.exitCode = await main();
