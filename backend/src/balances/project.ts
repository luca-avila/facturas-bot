import type { Money } from '../common/money.js';
import type { DebtStatus } from './balances.types.js';

export interface Projection {
  status: DebtStatus;
  remaining: Money;
  partial: boolean;
}

/**
 * A debt's status after applying `amount` to it, for the split preview.
 *
 * This repeats one rule of `counted` in `balances.service.ts`: the status is
 * `paid` when what's left reaches zero (`a.applied = d.total` in the status
 * `CASE`), and `partial` means something is applied and something is left.
 * Keep the two together: a test checks that the account shows exactly what
 * the preview predicted.
 */
export function projectAfter(
  now: { status: DebtStatus; remaining: Money; applied: Money },
  amount: Money,
): Projection {
  const remaining = now.remaining.subtract(amount);
  const applied = now.applied.add(amount);
  return {
    status: remaining.isZero() ? 'paid' : now.status,
    remaining,
    partial: applied.isPositive() && remaining.isPositive(),
  };
}
