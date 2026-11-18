import { PrismaService } from '../prisma/prisma.service.js';

describe('suppliers table', () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function insert(
    paymentTermDays: number | null,
    cuit: string | null = null,
  ): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO suppliers (name, cuit, payment_term_days)
      VALUES ('Panadería de prueba', ${cuit}, ${paymentTermDays})`;
  }

  it('accepts an informal supplier with a term of 0 or none', async () => {
    await expect(insert(0)).resolves.toBeUndefined();
    await expect(insert(null)).resolves.toBeUndefined();
  });

  it('refuses a payment term of -1', async () => {
    await expect(insert(-1)).rejects.toThrow(
      /suppliers_payment_term_days_non_negative/,
    );
  });

  it.each([
    ['ten digits', '3000000001'],
    ['letters', '30abcdefgh5'],
    ['hyphens', '30-0000001-'],
  ])('refuses a CUIT with %s', async (_, cuit) => {
    await expect(insert(30, cuit)).rejects.toThrow(/suppliers_cuit_digits/);
  });
});
