import { TEST_CUITS } from '../../test/test-cuits.js';
import { isValidCuit } from './cuit.js';

describe('isValidCuit', () => {
  it.each(TEST_CUITS)('accepts test CUIT %s', (cuit) => {
    expect(isValidCuit(cuit)).toBe(true);
  });

  it('accepts a check digit of 0', () => {
    expect(isValidCuit('30000000090')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidCuit('30000000016')).toBe(false);
  });

  it('rejects every last digit for a body with no possible check digit', () => {
    for (let last = 0; last <= 9; last++) {
      expect(isValidCuit(`2000000001${last}`)).toBe(false);
    }
  });

  it.each(['3000000001', '300000000150', '30-00000001-5', '3000000001a', 'abcdefghijk', ''])(
    'rejects %j',
    (value) => {
      expect(isValidCuit(value)).toBe(false);
    },
  );
});
