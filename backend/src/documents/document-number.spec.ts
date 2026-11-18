import { normalizeNumber } from './document-number.js';

describe('normalizeNumber', () => {
  it.each([
    ['0001-00004521', '000100004521'],
    ['0001 00004521', '000100004521'],
    ['A-0001/00004521', '000100004521'],
    ['7', '7'],
  ])('%s gives %s', (number, expected) => {
    expect(normalizeNumber(number)).toBe(expected);
  });

  it.each(['s/n', '', '-', 'abc'])('%j gives null', (number) => {
    expect(normalizeNumber(number)).toBeNull();
  });
});
