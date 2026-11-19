import { Money } from '../common/money.js';
import { projectAfter } from './project.js';

const m = (amount: string) => Money.fromString(amount);
const after = (
  status: 'pending' | 'overdue',
  remaining: string,
  applied: string,
  amount: string,
) => {
  const result = projectAfter(
    { status, remaining: m(remaining), applied: m(applied) },
    m(amount),
  );
  return { ...result, remaining: result.remaining.toString() };
};

describe('projectAfter', () => {
  it('becomes paid when what is left reaches zero', () => {
    expect(after('overdue', '100.00', '0.00', '100.00')).toEqual({
      status: 'paid',
      remaining: '0.00',
      partial: false,
    });
  });

  it('keeps the status while something is left, and is partial', () => {
    expect(after('pending', '50.00', '0.00', '20.00')).toEqual({
      status: 'pending',
      remaining: '30.00',
      partial: true,
    });
    expect(after('overdue', '50.00', '0.00', '0.01').status).toBe('overdue');
  });

  it('is not partial with nothing applied before or now', () => {
    expect(after('pending', '50.00', '0.00', '0.00')).toEqual({
      status: 'pending',
      remaining: '50.00',
      partial: false,
    });
  });

  it('stays partial with nothing new when something was applied before', () => {
    expect(after('pending', '30.00', '20.00', '0.00').partial).toBe(true);
  });
});
