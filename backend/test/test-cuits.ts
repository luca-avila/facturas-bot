/**
 * Invented CUITs for tests and fixtures. The repo is public, so every CUIT in
 * a committed file must come from here: the CUIT check fails on any other
 * valid one. They're invented, with seven zeros and one digit in the middle.
 * Nobody has checked that no real person or company holds one: 20-00000002-8
 * would be a person with DNI 2.
 *
 * `cuit` is unique and spec files run in parallel against one database, so
 * each spec file that gives suppliers a CUIT has its own group, and frees
 * only that group before each test.
 */

/** For `suppliers.spec.ts` only. */
export const SUPPLIER_SPEC_CUITS: readonly string[] = [
  '30000000015', // test supplier (company)
  '30000000023', // second test supplier
  '30000000031', // third test supplier
  '30000000090', // check digit 0 case
  '20000000028', // test supplier (person)
];

/** Vitest's `RESTAURANT_CUIT`. No supplier ever has it. */
export const RESTAURANT_TEST_CUIT = '30000000112';

/** For `extraction-result.spec.ts` only. */
export const EXTRACTION_RESULT_CUITS: readonly string[] = [
  '30000000066',
  '30000000074',
];

/** For `extraction-worker.spec.ts` only. */
export const EXTRACTION_WORKER_CUITS: readonly string[] = ['30000000082'];

/** For `extraction-flow.spec.ts` only. */
export const EXTRACTION_FLOW_CUITS: readonly string[] = ['30000000104'];

/** Every test CUIT: what the CUIT check lets through. */
export const TEST_CUITS: readonly string[] = [
  ...SUPPLIER_SPEC_CUITS,
  RESTAURANT_TEST_CUIT,
  ...EXTRACTION_RESULT_CUITS,
  ...EXTRACTION_WORKER_CUITS,
  ...EXTRACTION_FLOW_CUITS,
];
