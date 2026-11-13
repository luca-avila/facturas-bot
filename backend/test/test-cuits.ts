/**
 * Invented CUITs for tests and fixtures. The repo is public, so every CUIT in
 * a committed file must come from here: the CUIT check fails on any other
 * valid one. They're invented, with seven zeros and one digit in the middle.
 * Nobody has checked that no real person or company holds one: 20-00000002-8
 * would be a person with DNI 2.
 */
export const TEST_CUITS: readonly string[] = [
  '30000000015', // test supplier (company)
  '30000000023', // second test supplier
  '30000000031', // third test supplier
  '30000000090', // check digit 0 case
  '20000000028', // test supplier (person)
];
