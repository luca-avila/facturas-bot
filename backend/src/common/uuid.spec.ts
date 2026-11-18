import { randomUUID } from 'node:crypto';
import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it('accepts a random UUID, in either case', () => {
    const id = randomUUID();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id.toUpperCase())).toBe(true);
  });

  it.each([
    '',
    'not-a-uuid',
    '123',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaaa',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'gaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ])('rejects %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
