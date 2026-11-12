// Bans shared by the backend and frontend ESLint configs, so they can't drift.
//
// Money bans and clock bans live in different rules on purpose: the backend's
// `money.ts` turns off only the money rules and `clock.ts` only the clock rule,
// so neither exception lifts the other ban.

const MONEY_MESSAGE =
  'Floats lose cents. Use Money (backend/src/common/money.ts) for amounts.';
const CLOCK_MESSAGE =
  "Reading the clock here can give the wrong day. Use today() (backend/src/common/clock.ts), or vi.setSystemTime() in tests.";

/** `parseFloat` and `toFixed`. Turned off only in the backend's `money.ts`. */
export const moneyBans = {
  'no-restricted-globals': ['error', { name: 'parseFloat', message: MONEY_MESSAGE }],
  'no-restricted-properties': [
    'error',
    { object: 'Number', property: 'parseFloat', message: MONEY_MESSAGE },
    { object: 'globalThis', property: 'parseFloat', message: MONEY_MESSAGE },
    { property: 'toFixed', message: MONEY_MESSAGE },
  ],
};

/** `new Date()`, `Date()` and `Date.now()`. Turned off only in the backend's `clock.ts`. */
export const clockBans = {
  'no-restricted-syntax': [
    'error',
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
    { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: CLOCK_MESSAGE,
    },
  ],
};

/** The rule names each exception may turn off. */
export const moneyBanRules = Object.keys(moneyBans);
export const clockBanRules = Object.keys(clockBans);
