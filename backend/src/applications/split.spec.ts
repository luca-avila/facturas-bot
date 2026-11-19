import { Money } from '../common/money.js';
import { evaluate, suggest } from './split.js';

const m = (amount: string) => Money.fromString(amount);
const rows = (...remaining: string[]) =>
  remaining.map((r, i) => ({ id: `doc-${i}`, remaining: m(r) }));
const printed = (amounts: Map<string, Money>) =>
  Object.fromEntries([...amounts].map(([id, a]) => [id, a.toString()]));

describe('suggest', () => {
  it('fills each row in order, oldest first', () => {
    expect(printed(suggest(m('120.00'), rows('100.00', '50.00')))).toEqual({
      'doc-0': '100.00',
      'doc-1': '20.00',
    });
  });

  it('gives every row after the money runs out zero', () => {
    expect(
      printed(suggest(m('50.00'), rows('100.00', '50.00', '10.00'))),
    ).toEqual({ 'doc-0': '50.00', 'doc-1': '0.00', 'doc-2': '0.00' });
  });

  it('leaves what is over unapplied', () => {
    const targets = rows('100.00', '50.00');
    const amounts = suggest(m('200.00'), targets);
    expect(printed(amounts)).toEqual({ 'doc-0': '100.00', 'doc-1': '50.00' });
    expect(evaluate(m('200.00'), targets, amounts).unapplied.toString()).toBe(
      '50.00',
    );
  });

  it('suggests nothing without rows', () => {
    expect(suggest(m('80.00'), []).size).toBe(0);
  });
});

describe('evaluate', () => {
  const targets = rows('100.00', '50.00');
  const amounts = (a: string, b: string) =>
    new Map([
      ['doc-0', m(a)],
      ['doc-1', m(b)],
    ]);
  const summary = (available: string, a: string, b: string) => {
    const result = evaluate(m(available), targets, amounts(a, b));
    return {
      applied: result.applied.toString(),
      unapplied: result.unapplied.toString(),
      excess: result.excess.toString(),
      exceeding: [...result.exceeding],
    };
  };

  it('adds the rows up exactly and leaves the rest as credit', () => {
    expect(summary('120.00', '100.00', '15.00')).toEqual({
      applied: '115.00',
      unapplied: '5.00',
      excess: '0.00',
      exceeding: [],
    });
  });

  it('leaves nothing when the rows use it all', () => {
    expect(summary('120.00', '100.00', '20.00')).toEqual({
      applied: '120.00',
      unapplied: '0.00',
      excess: '0.00',
      exceeding: [],
    });
  });

  it('flags a row that is more than it has left', () => {
    expect(summary('120.00', '60.00', '50.01')).toEqual({
      applied: '110.01',
      unapplied: '9.99',
      excess: '0.00',
      exceeding: ['doc-1'],
    });
  });

  it('gives the excess when the rows go over what is available', () => {
    expect(summary('120.00', '100.00', '50.00').excess).toBe('30.00');
    expect(summary('120.00', '100.00', '50.00').unapplied).toBe('0.00');
  });

  it('applies nothing when every row is zero', () => {
    expect(summary('80.00', '0', '0')).toEqual({
      applied: '0.00',
      unapplied: '80.00',
      excess: '0.00',
      exceeding: [],
    });
  });

  it('counts an amount for a document that is not a row', () => {
    const result = evaluate(
      m('10.00'),
      targets,
      new Map([['elsewhere', m('15.00')]]),
    );
    expect(result.applied.toString()).toBe('15.00');
    expect(result.excess.toString()).toBe('5.00');
    expect(result.exceeding.size).toBe(0);
  });
});
