import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Money } from './money.js';

describe('Money', () => {
  const sum = (a: string, b: string) => Money.fromString(a).add(Money.fromString(b)).toString();

  it('adds cents exactly', () => {
    expect(sum('0.10', '0.20')).toBe('0.30');
  });

  it('adds exactly at the top of the numeric(14,2) range', () => {
    expect(sum('999999999999.99', '0.01')).toBe('1000000000000.00');
  });

  it('prints zero without a minus sign', () => {
    expect(sum('-5.00', '5.00')).toBe('0.00');
    expect(Money.fromString('-0.00').toString()).toBe('0.00');
  });

  it('prints a negative amount with its sign', () => {
    expect(sum('-5.00', '1.25')).toBe('-3.75');
  });

  it('reads one decimal and prints two', () => {
    expect(Money.fromString('1234.5').toString()).toBe('1234.50');
  });

  it('accepts 12 integer digits and rejects 13', () => {
    expect(Money.fromString('999999999999.99').toString()).toBe('999999999999.99');
    expect(() => Money.fromString('1000000000000.00')).toThrow();
    expect(() => Money.fromString('-1000000000000')).toThrow();
  });

  it.each([
    ['0.00', false],
    ['-0.01', false],
    ['-5.00', false],
    ['0.01', true],
    ['86900.50', true],
  ])('isPositive(%s) is %s', (value, expected) => {
    expect(Money.fromString(value).isPositive()).toBe(expected);
  });

  it('compare orders -1.00, 0.00, 0.01, 10.00', () => {
    const values = ['10.00', '0.01', '-1.00', '0.00'].map((v) => Money.fromString(v));
    const sorted = [...values].sort((a, b) => a.compare(b));
    expect(sorted.map((m) => m.toString())).toEqual(['-1.00', '0.00', '0.01', '10.00']);
    expect(Money.fromString('1.50').compare(Money.fromString('1.5'))).toBe(0);
    expect(Money.fromString('2.00').compare(Money.fromString('10.00'))).toBeLessThan(0);
    expect(Money.fromString('10.00').compare(Money.fromString('2.00'))).toBeGreaterThan(0);
  });

  it('subtracts exactly at 12 digits', () => {
    const diff = (a: string, b: string) => Money.fromString(a).subtract(Money.fromString(b)).toString();
    expect(diff('999999999999.99', '0.01')).toBe('999999999999.98');
    expect(diff('0.30', '0.10')).toBe('0.20');
    expect(diff('0.10', '999999999999.99')).toBe('-999999999999.89');
    expect(diff('5.00', '5.00')).toBe('0.00');
  });

  it.each([
    ['0.00', true],
    ['-0.00', true],
    ['0.01', false],
    ['-0.01', false],
  ])('isZero(%s) is %s', (value, expected) => {
    expect(Money.fromString(value).isZero()).toBe(expected);
  });

  it.each(['', ' 1.00', '1.00 ', '1,50', '1.234,56', '1e3', '+1.00', '1.005', 'abc', 'NaN', '1.'])(
    'rejects %j',
    (value) => {
      expect(() => Money.fromString(value)).toThrow();
    },
  );

  describe('round trip through Postgres numeric(14,2)', () => {
    let prisma: PrismaService;
    let close: () => Promise<void>;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      close = () => moduleRef.close();
    });

    afterAll(async () => {
      await close();
    });

    async function throughPostgres(value: string): Promise<string> {
      const rows = await prisma.$queryRaw<{ value: string }[]>`
        SELECT ${value}::numeric(14,2)::text AS value`;
      return rows[0].value;
    }

    it.each(['999999999999.99', '0.10'])('keeps %s unchanged', async (value) => {
      const stored = await throughPostgres(Money.fromString(value).toString());
      expect(stored).toBe(value);
      expect(Money.fromString(stored).toString()).toBe(Money.fromString(value).toString());
    });

    it('stores 1234.5 as 1234.50', async () => {
      const stored = await throughPostgres(Money.fromString('1234.5').toString());
      expect(stored).toBe('1234.50');
      expect(Money.fromString(stored).toString()).toBe('1234.50');
    });
  });
});
