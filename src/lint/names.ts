// Which column names look like money (SPEC.md §3.5). A name looks like money when ANY of its words is a
// money word and its LAST word is not a word that turns it into something else (an id, a date, a
// count, a rate): "amount_due" is money, "amount_currency" and "price_id" are not. A generic money word
// (total, net, credit...) that is the only one counts at the end or before words that say what the money
// is ("total_paid"), not before a measure ("total_co2"). Words after "per"
// only say what the amount is for ("price_per_month" is money), unless the name ends in a ratio
// ("fee_per_txn_bps"); a pay rate or a priced rate is money ("hourly_rate", "rate_per_hour"); so is
// what an order or a cart is worth ("order_value"). A one-word name that PostgreSQL folded to
// lowercase ("TotalAmount" became "totalamount") is split into known words first ("total", "amount"),
// so it gets the answer its snake_case form gets, and so is a folded word inside a longer name
// ("totalamount_old"), for both rules here; a one-word name that cannot be split is money when it ends
// in a long money word, or starts with one and does not end in a long non-money word. A number at the
// end is dropped ("price2", "credit_card_last4").

import {
  MONEY_WORDS,
  COUNT_WORDS,
  MEASURE_WORDS,
  NOT_MONEY_LAST_WORDS,
  MINOR_UNIT_WORDS,
  UNSURE_UNIT_WORDS,
  ZERO_DECIMAL_CURRENCIES,
  MORE_DECIMAL_CURRENCIES,
  FINER_UNIT_WORDS,
  GENERIC_MONEY_WORDS,
  RATIO_WORDS,
  PAY_RATE_WORDS,
  PRICED_UNITS,
  VALUE_WORDS,
  OTHER_WORDS,
  GENERIC_MEASURE_WORDS,
  TOTALLED_WORDS,
  FOLDED_MONEY_ENDINGS,
  FOLDED_UNIT_ENDINGS,
  FOLDED_NOT_MONEY_ENDINGS,
} from './name-words.js';


/** A folded one-word name ("totalamount", "amountminor") without its unit ending, if it has one. */
function withoutUnit(word: string): string {
  const unit = FOLDED_UNIT_ENDINGS.find((u) => word.length > u.length && word.endsWith(u));
  return unit === undefined ? word : word.slice(0, -unit.length);
}

/**
 * Every word the rule knows, to split a folded name by; the unit words too, so that "amountjpy" (an
 * unquoted AmountJPY) gets the unit "amount_jpy" gets.
 */
const VOCABULARY: ReadonlySet<string> = new Set([
  ...MONEY_WORDS, ...NOT_MONEY_LAST_WORDS, ...MINOR_UNIT_WORDS, ...UNSURE_UNIT_WORDS, ...ZERO_DECIMAL_CURRENCIES, ...MORE_DECIMAL_CURRENCIES,
  ...FINER_UNIT_WORDS, ...RATIO_WORDS, ...PAY_RATE_WORDS, ...PRICED_UNITS, ...VALUE_WORDS, ...OTHER_WORDS,
  // what a balance, budget or allowance may hold, so that "leavebalance" splits (review round 18); a word another
  // list already holds (holiday, sick, stock, inventory, booking, shipping) is not repeated (round 19)
  'leave', 'holidays', 'pto', 'vacation', 'error', 'baggage', 'luggage', 'data',
  // what a folded -ing name may start with, so that "marketingbudget" splits (review round 18)
  'marketing', 'listing', 'advertising', 'parking', 'packaging', 'training', 'funding',
]);

/**
 * A folded name split into known words of two letters or more, in as few as can be ("totaldiscount": total + discount;
 * round 17: not "marketing" as market + in + g); undefined when it cannot be split entirely into known words.
 */
function split(word: string): string[] | undefined {
  const best: Array<string[] | undefined> = [[]]; // best[i]: the fewest words that make up word[0, i)
  for (let end = 1; end <= word.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      const head = best[start];
      if (head === undefined || end - start < 2 || !VOCABULARY.has(word.slice(start, end))) continue;
      const current = best[end];
      if (current === undefined || head.length + 1 < current.length) best[end] = [...head, word.slice(start, end)];
    }
  }
  return best[word.length];
}

/**
 * The lowercase words of a column name: split at "_", "-", spaces and dots, at camelCase boundaries
 * ("amountMinor", "GBPAmount") and between letters and digits ("price2").
 */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/**
 * The words of a name as the rules read them: each word the rule does not know is split into known
 * words where it can be ("totalamount_old": total, amount, old; "amountminorunits": amount, minor,
 * units), and a number at the end is dropped ("price2", "credit_card_last4": a version or a label).
 */
function knownWords(name: string): string[] {
  const out = words(name).flatMap((w) => (VOCABULARY.has(w) || /^\d+$/.test(w) ? [w] : (split(w) ?? [w])));
  while (out.length > 1 && /^\d+$/.test(out.at(-1) ?? '')) out.pop();
  return out;
}

/** Words that say what money is, or its unit, after a generic money word: "total_paid", "net_gbp". */
const SAYS_MONEY: ReadonlySet<string> = new Set([
  ...MONEY_WORDS, ...OTHER_WORDS, ...MINOR_UNIT_WORDS, ...UNSURE_UNIT_WORDS, ...ZERO_DECIMAL_CURRENCIES, ...MORE_DECIMAL_CURRENCIES, ...FINER_UNIT_WORDS,
]);

/**
 * "money"; "guess" when only a generic money word says so, followed by a word that does not say
 * money ("total_passengers", "net_ytd"); "not".
 */
type Verdict = 'money' | 'guess' | 'not';

export function looksLikeMoney(name: string): boolean {
  return judgeWords(knownWords(name)) !== 'not';
}

/**
 * Whether a name is money only by a guess: a generic money word followed by a word the rule does not
 * know as money. Its fix_sql must not multiply by 100 (SPEC.md §3.5): "total_passengers" may be a count.
 */
export function moneyByGuess(name: string): boolean {
  return judgeWords(knownWords(name)) === 'guess';
}

/** What a balance, budget or allowance holds when it is not money: time off, errors, baggage (review round 17). */
const HELD_OWN_WORDS: ReadonlySet<string> = new Set(['leave', 'holiday', 'holidays', 'pto', 'vacation', 'sick', 'error', 'baggage', 'luggage', 'mass', 'fluid', 'calorie', 'token', 'point', 'overtime', 'flexi', 'flexitime', 'toil']);
const HELD_WORDS: ReadonlySet<string> = new Set([...TOTALLED_WORDS, ...HELD_OWN_WORDS].filter((w) => w !== 'mileage'));

/** What it may hold either way: an inventory balance is money in accounting, a data allowance is not (review round 18). */
const HELD_GUESS_WORDS: ReadonlySet<string> = new Set(['stock', 'inventory', 'data', 'time', 'mileage']); // a mileage allowance is paid in pence per mile (round 19)
/** The same for a budget. */
const BUDGET_GUESS_WORDS: ReadonlySet<string> = new Set(['data', 'mileage']);

/**
 * What a balance, budget or allowance holds when one of these follows it: "balance_hours_remaining",
 * "allowance_days_left", "budget_tokens_remaining" (review round 19). Not every measure: "balance_change" is money.
 */
const HELD_AFTER_WORDS: ReadonlySet<string> = new Set(['hours', 'hrs', 'days', 'nights', 'weeks', 'months', 'years', 'minutes', 'mins', 'seconds', 'secs', 'tokens', 'points', 'leave', 'holiday', 'holidays', 'pto', 'vacation', 'sick']);

/** A budget is money unless it is of computing or time (review round 18: holiday and stock budgets are money). */
// Round 19: the time words of a budget in days or hours ("pto_days_budget"), not "day" or "month" ("month_budget" is money).
const BUDGET_OWN_WORDS: ReadonlySet<string> = new Set(['error', 'token', 'calorie', 'calories', 'time', 'hour', 'hours', 'hrs', 'minute', 'minutes', 'mins', 'second', 'seconds', 'secs', 'ms', 'days', 'nights', 'weeks']);
const BUDGET_HELD_WORDS: ReadonlySet<string> = new Set([...GENERIC_MEASURE_WORDS, ...BUDGET_OWN_WORDS].filter((w) => w !== 'mileage'));

/**
 * Whether the total (or balance, budget, allowance) at `at` holds a count or a measure: one of `words`
 * stands between it and the money word nearest before it ("fee_count_total", "weight_total",
 * "hours_balance"), not before that word ("energy_cost_total" totals costs).
 */
function totalsAMeasure(ws: readonly string[], at: number, words: ReadonlySet<string> = TOTALLED_WORDS): boolean {
  const money = ws.slice(0, at).map((w) => MONEY_WORDS.has(w) && w !== 'total' && w !== 'totals').lastIndexOf(true);
  return ws.slice(money + 1, at).some((w) => words.has(w));
}

function judgeWords(all: readonly string[]): Verdict {
  const end = all.at(-1) ?? '';
  // "debit_in_account_currency": the debit is the column; the rest says which currency it is in.
  const inAt = all.indexOf('in');
  if ((end === 'currency' || end === 'ccy') && inAt > 0) return judgeWords(all.slice(0, inAt));
  if (RATIO_WORDS.has(end) && all.includes('per')) return 'not'; // "fee_per_txn_bps": a ratio
  if (end === 'rate' && PAY_RATE_WORDS.has(all.at(-2) ?? '')) return 'money'; // "hourly_rate": a price of time
  const per = all.indexOf('per');
  if (per === 1 && all[0] === 'rate' && PRICED_UNITS.has(all[2] ?? '')) return 'money'; // "rate_per_hour": a price
  const ws = per > 0 ? all.slice(0, per) : all; // "price_per_month": the price is the column, the month what it is for
  const last = ws.at(-1);
  if (last === undefined) return 'not';
  // "amount_minor_units", "amount_in_smallest_unit": the unit of an amount, not a count of units;
  // "price_unit" (Odoo's unit price on every order line): a price per unit.
  const unitOfAmount = (last === 'unit' || last === 'units') && ['minor', 'smallest', 'lowest', 'price', 'cost'].includes(ws.at(-2) ?? '');
  if (pricesAMeasure(ws)) return 'money'; // "price_kg", "cost_kwh": a price per unit (review round 19)
  if (NOT_MONEY_LAST_WORDS.has(last) && !unitOfAmount) return 'not';
  if ((last === 'value' || last === 'values') && VALUE_WORDS.has(ws.at(-2) ?? '')) return 'money'; // "order_value"
  // A count or measure between the last money word and a final total, balance, budget or allowance says
  // what it holds: "weight_total", "fee_count_total" (round 10), "leave_balance" (round 17), not "energy_cost_total".
  if ((last === 'total' || last === 'totals') && totalsAMeasure(ws, ws.length - 1)) return 'not';
  // The last balance (or bal), budget or allowance anywhere, unless money follows it (round 18: "leave_balance_remaining";
  // round 19: "pto_bal", and what follows it, "balance_hours_remaining").
  const held = ws.map((w) => /^(?:balance|budget|allowance|bal)s?$/.test(w)).lastIndexOf(true);
  if (held >= 0 && !ws.slice(held + 1).some((w) => MONEY_WORDS.has(w))) {
    const budget = /^budgets?$/.test(ws[held] ?? '');
    if (totalsAMeasure(ws, held, budget ? BUDGET_HELD_WORDS : HELD_WORDS) || ws.slice(held + 1).some((w) => HELD_AFTER_WORDS.has(w))) return 'not';
    if (totalsAMeasure(ws, held, budget ? BUDGET_GUESS_WORDS : HELD_GUESS_WORDS)) return 'guess';
  }
  // "minor" says the unit of an amount beside another money word ("amount_minor"); beside a version it
  // is a version part ("version_minor"); alone, or with unit ("minor_unit", ISO 4217's currency
  // exponent), it is not an amount.
  if (ws.some((w) => MONEY_WORDS.has(w) && w !== 'minor' && !GENERIC_MONEY_WORDS.has(w))) return 'money';
  // A generic money word counts unless a measure follows it: "total_paid" and "net_ytd" are money,
  // "total_co2" and "credit_utilization" measures. "units" after minor or smallest is the unit of the money.
  // Words after it, or before it, that do not say money leave a guess: "net_ytd",
  // "total_passengers", "water_total" (review round 10: "steps_total" was money, "total_steps" not).
  const generic = ws.map((w) => GENERIC_MONEY_WORDS.has(w)).lastIndexOf(true);
  if (generic >= 0) {
    if ((ws[generic] === 'total' || ws[generic] === 'totals') && totalsAMeasure(ws, generic)) return 'not';
    const after = ws.slice(generic + 1);
    const unitOfMoney = (w: string, i: number) => (w === 'unit' || w === 'units') && ['minor', 'smallest', 'lowest'].includes(after[i - 1] ?? '');
    if (after.some((w, i) => GENERIC_MEASURE_WORDS.has(w) || (NOT_MONEY_LAST_WORDS.has(w) && !unitOfMoney(w, i)))) return 'not';
    const before = ws.slice(0, generic).filter((w) => !GENERIC_MONEY_WORDS.has(w));
    return after.every((w, i) => SAYS_MONEY.has(w) || unitOfMoney(w, i)) && before.every((w) => SAYS_MONEY.has(w)) ? 'money' : 'guess';
  }
  if (ws.length !== 1 || last === 'minor') return 'not';
  // A folded name the known words cannot split: the long money words at either end. Total, a generic
  // word, beside words the rule cannot read is a guess ("totalco2", "stepstotal"), as in snake_case.
  const word = withoutUnit(last);
  const ending = FOLDED_MONEY_ENDINGS.find((e) => word.endsWith(e));
  if (ending !== undefined) return ending === 'total' && word !== 'total' ? 'guess' : 'money';
  const start = FOLDED_MONEY_ENDINGS.find((s) => word.startsWith(s));
  if (start === undefined || FOLDED_NOT_MONEY_ENDINGS.some((e) => word.endsWith(e))) return 'not';
  return start === 'total' ? 'guess' : 'money';
}


/** What a price "per" a time or a person is for: an ordinary price, never below a penny (review round 19). */
const PER_PERIOD_WORDS: ReadonlySet<string> = new Set(['hour', 'hours', 'hr', 'day', 'days', 'night', 'nights', 'week', 'weeks', 'month', 'months', 'year', 'years', 'annum', 'quarter', 'person', 'guest', 'stay', 'visit']);

/**
 * Whether a name is the price of one unit ("price_per_kwh", "unit_price", "cost_per_request", "price_unit"): such
 * prices go below a penny, so a float or a numeric with no scale may hold more decimals than a fix keeps (review
 * round 18). A price per hour, night, month or person is not (round 19: price_per_month, salary_per_annum).
 */
/** The measure units a price can be given per without "per": "price_kg", "cost_kwh", "fuel_price_litre" (review round 19). */
const PRICED_MEASURE_WORDS: ReadonlySet<string> = new Set(['kg', 'g', 'mg', 'lb', 'km', 'mile', 'kwh', 'ml', 'litre', 'liter', 'gb', 'mb']);

/** Whether a name ends in price, cost or fee and then a measure unit. */
function pricesAMeasure(ws: readonly string[]): boolean {
  return PRICED_MEASURE_WORDS.has(ws.at(-1) ?? '') && ['price', 'cost', 'fee'].includes(ws.at(-2) ?? '');
}

export function pricesAUnit(name: string): boolean {
  const ws = knownWords(name);
  const per = ws.indexOf('per');
  return pricesAMeasure(ws) || (per >= 0 && !PER_PERIOD_WORDS.has(ws[per + 1] ?? '')) || ws.some((w, i) => (w === 'unit' || w === 'units') && ['price', 'cost', 'amount', 'rate', 'fee'].some((m) => ws[i - 1] === m || ws[i + 1] === m));
}

/**
 * What a money column's name says about its unit: "minor" when it says minor units plainly (a
 * minor-unit word: "amount_pence", "price_cents_usd", "amount_sats"; "minor" or "smallest" before unit
 * or units: "amount_minor_units", "amount_in_smallest_unit"; a currency with no minor unit:
 * "amount_jpy"); "unsure" when it holds a word that may mean minor units or something else
 * ("amount_minor", "price_minor", "price_sat"), a unit finer than a minor unit ("cost_micros",
 * "price_gwei") or a currency with more than two decimals ("amount_kwd"): a fix needs that decided
 * first; "major" otherwise.
 */

export function unitOfName(name: string): 'minor' | 'major' | 'unsure' {
  // Review round 10: three ways a name seemed to say minor units when it did not.
  // Words after "per" say what the amount is for, not its unit ("price_per_cent", as the money rule reads it).
  const all = knownWords(name);
  const per = all.indexOf('per');
  const ws = per > 0 ? all.slice(0, per) : all;
  if (ws.some((w) => FINER_UNIT_WORDS.has(w) || MORE_DECIMAL_CURRENCIES.has(w))) return 'unsure';
  // Only the word right after "per" says what the amount is for; a unit word after that is the amount's
  // own ("price_per_unit_cents", "cost_per_click_micros"): review round 16, where they read as pounds.
  const after = per > 0 ? all.slice(per + 2) : [];
  const isUnit = (w: string) => MINOR_UNIT_WORDS.has(w) || UNSURE_UNIT_WORDS.has(w) || FINER_UNIT_WORDS.has(w) || MORE_DECIMAL_CURRENCIES.has(w) || ZERO_DECIMAL_CURRENCIES.has(w);
  if (after.some(isUnit)) {
    const last = all.at(-1) ?? '';
    return (MINOR_UNIT_WORDS.has(last) && !UNSURE_UNIT_WORDS.has(last)) || ZERO_DECIMAL_CURRENCIES.has(last) ? 'minor' : 'unsure';
  }
  // "minor unit", "smallest unit", "lowest denomination", when no money word follows: "lowest_unit_price"
  // is the lowest price of a product's unit, in pounds.
  const unitAfter = (i: number) => ['unit', 'units', 'denomination'].includes(ws[i + 1] ?? '') && !ws.slice(i + 2).some((w) => MONEY_WORDS.has(w));
  if (ws.some((w, i) => ['minor', 'smallest', 'lowest'].includes(w) && unitAfter(i))) return 'minor';
  // Before the money word, only pence, cents and pennies plainly give the unit ("pence_total"); others
  // may name a product or a brand ("subunit_price", "kobo_price", "penny_stock_price"): unsure.
  const money = ws.findIndex((w) => MONEY_WORDS.has(w) && !MINOR_UNIT_WORDS.has(w));
  const leading = (w: string, i: number) => i < money && !['pence', 'cents', 'pennies'].includes(w);
  if (ws.some((w, i) => MINOR_UNIT_WORDS.has(w) && !UNSURE_UNIT_WORDS.has(w) && !leading(w, i))) return 'minor';
  if (ws.some((w, i) => UNSURE_UNIT_WORDS.has(w) || (MINOR_UNIT_WORDS.has(w) && leading(w, i)))) return 'unsure';
  if (ws.some((w) => ZERO_DECIMAL_CURRENCIES.has(w))) return 'minor'; // whole yen are its smallest unit
  // A folded name the known words cannot split, ending in a unit word ("grossamountpence").
  const only = ws.length === 1 ? ws[0] : undefined;
  if (only === undefined || withoutUnit(only) === only) return 'major';
  const ending = only.slice(withoutUnit(only).length);
  return UNSURE_UNIT_WORDS.has(ending) || FINER_UNIT_WORDS.has(ending) ? 'unsure' : 'minor';
}

/** Sub-lists of the non-money last words that the rule before total uses, for the same test. */
export const SUB_LISTS: Readonly<Record<string, ReadonlySet<string>>> = {
  counts: COUNT_WORDS,
  'rates and measures': MEASURE_WORDS,
};

/** The word lists, for the test that holds SPEC.md §3.5 to them. */
export const WORD_LISTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'Money words': MONEY_WORDS,
  'Generic money word list': GENERIC_MONEY_WORDS,
  'Measures after generic money words': GENERIC_MEASURE_WORDS,
  'Words beside money words': OTHER_WORDS,
  'Non-money last words': NOT_MONEY_LAST_WORDS,
  'Minor-unit words': new Set([...MINOR_UNIT_WORDS].filter((w) => !UNSURE_UNIT_WORDS.has(w))),
  'Currencies without minor units': ZERO_DECIMAL_CURRENCIES,
  'Unsure unit words': UNSURE_UNIT_WORDS,
  'Finer units': FINER_UNIT_WORDS,
  'Currencies with more than two decimals': MORE_DECIMAL_CURRENCIES,
};

/** The word lists in the prose rules of SPEC.md §3.5, for the test that holds each to its list there. */
export const RULE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  ratio: RATIO_WORDS,
  payRate: PAY_RATE_WORDS,
  priced: PRICED_UNITS,
  value: VALUE_WORDS,
  held: HELD_OWN_WORDS,
  heldGuess: HELD_GUESS_WORDS,
  budgetHeld: BUDGET_OWN_WORDS,
  heldAfter: HELD_AFTER_WORDS,
  pricedMeasure: PRICED_MEASURE_WORDS,
};
