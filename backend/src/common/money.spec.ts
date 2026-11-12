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
