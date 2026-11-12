/**
 * Invented CUITs for tests and fixtures. The repo is public, so every CUIT in
 * a committed file must come from here: the CUIT check fails on any other
 * valid one. The middle eight digits are zeros, so they can't belong to anyone.
 */
export const TEST_CUITS: readonly string[] = [
  '30000000015', // test supplier (company)
  '30000000023', // second test supplier
  '30000000031', // third test supplier
  '30000000090', // check digit 0 case
  '20000000028', // test supplier (person)
];
