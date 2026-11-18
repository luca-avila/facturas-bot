import { Money } from '../common/money.js';

/** A document a split can apply to, with what it has left to pay. */
export interface SplitTarget {
  id: string;
  remaining: Money;
}

export interface Evaluation {
  /** Σ of every amount. */
  applied: Money;
  /** What stays as credit. Zero when the amounts go over `available`. */
  unapplied: Money;
  /** How much the amounts go over `available`. Zero otherwise. */
  excess: Money;
  /** Rows whose amount is more than they have left (invariant 2). */
  exceeding: Set<string>;
}

const ZERO = Money.fromString('0');

const min = (a: Money, b: Money) => (a.compare(b) <= 0 ? a : b);

/**
 * The suggestion: each row, in the order given, takes the smaller of what it
 * has left and what's still available. Every row after the money runs out
 * gets zero.
 */
export function suggest(
  available: Money,
  rows: readonly SplitTarget[],
): Map<string, Money> {
  const amounts = new Map<string, Money>();
  let left = available;
  for (const row of rows) {
    const amount = left.isPositive() ? min(row.remaining, left) : ZERO;
    amounts.set(row.id, amount);
    left = left.subtract(amount);
  }
  return amounts;
}

/**
 * What a split does. The only arithmetic behind both the preview and the
 * save, so they can't disagree. Amounts for ids not in `rows` still count
 * towards `applied`: the caller refuses them as not applicable.
 */
export function evaluate(
  available: Money,
  rows: readonly SplitTarget[],
  amounts: ReadonlyMap<string, Money>,
): Evaluation {
  const applied = [...amounts.values()].reduce((sum, a) => sum.add(a), ZERO);
  const exceeding = new Set(
    rows
      .filter((row) => (amounts.get(row.id) ?? ZERO).compare(row.remaining) > 0)
      .map((row) => row.id),
  );
  const left = available.subtract(applied);
  return {
    applied,
    unapplied: left.isPositive() ? left : ZERO,
    excess: left.isPositive() ? ZERO : ZERO.subtract(left),
    exceeding,
  };
}
