import { Decimal } from 'decimal.js';

/** Up to 2 decimals, dot separator, optional leading minus. Nothing else. */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * An exact amount of money. Never a float: it's backed by `decimal.js`, and
 * this is the only file where ESLint allows `parseFloat` and `toFixed`.
 */
export class Money {
  private constructor(private readonly amount: Decimal) {}

  /**
   * Reads an amount such as `1234.5` or the `numeric(14,2)` string Postgres
   * returns. Throws on anything else, and never rounds.
   */
  static fromString(value: string): Money {
    if (!AMOUNT_PATTERN.test(value)) {
      throw new Error(`Invalid money amount: "${value}"`);
    }
    return new Money(new Decimal(value));
  }

  add(other: Money): Money {
    return new Money(this.amount.plus(other.amount));
  }

  /** Always exactly 2 decimals, like Postgres prints `numeric(14,2)`. */
  toString(): string {
    return this.amount.isZero() ? '0.00' : this.amount.toFixed(2);
  }
}
