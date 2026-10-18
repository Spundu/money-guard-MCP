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
  HELD_OWN_WORDS,
  HELD_GUESS_WORDS,
  BUDGET_GUESS_WORDS,
  HELD_AFTER_WORDS,
  BUDGET_OWN_WORDS,
  PER_ORDINARY_WORDS,
  PRICED_MEASURE_WORDS,
  SCALE_WORDS,
  FOLDING_WORDS,
  HELD_STATE_WORDS,
  NAV_MONEY_WORDS,
  BARE_GUESS_WORDS,
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
  // every list the rules read, so that "leavebalance", "flexibalance" and "costpergb" split (review rounds 18 and 20)
  ...GENERIC_MEASURE_WORDS, ...HELD_OWN_WORDS, ...HELD_GUESS_WORDS, ...HELD_AFTER_WORDS, ...BUDGET_OWN_WORDS, ...PRICED_MEASURE_WORDS, ...PER_ORDINARY_WORDS, ...SCALE_WORDS,
  ...FOLDING_WORDS, ...HELD_STATE_WORDS,
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
  const all = words(name).flatMap((w) => (VOCABULARY.has(w) || /^\d+$/.test(w) ? [w] : (split(w) ?? [w])));
  // "per diem" is a daily allowance, not a price per something (review round 20: "per_diem_rate", "per_diem_amount").
  const out = all.filter((w, i) => !(w === 'per' && all[i + 1] === 'diem'));
  // The number of a tier or a level stays: "price_tier_1" is the price of tier 1 (review round 22).
  while (out.length > 1 && /^\d+$/.test(out.at(-1) ?? '') && !['tier', 'level', 'band'].includes(out.at(-2) ?? '')) out.pop();
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

const HELD_WORDS: ReadonlySet<string> = new Set([...TOTALLED_WORDS, ...HELD_OWN_WORDS].filter((w) => w !== 'mileage'));
// A budget of a count or a measure is not money either, as for totals, but growth's is (review round 24: "kwh_budget" got x100).
const BUDGET_HELD_WORDS: ReadonlySet<string> = new Set([...TOTALLED_WORDS, ...BUDGET_OWN_WORDS].filter((w) => w !== 'mileage' && w !== 'growth'));

/** A measure word that is part of a money word before it: cash flow is money (review round 20: "cash_flow_total"). */
const partOfMoney = (ws: readonly string[], i: number) => (ws[i] === 'flow' || ws[i] === 'flows') && ws[i - 1] === 'cash';

/**
 * Whether the total (or balance, budget, allowance) at `at` holds a count or a measure: one of `words`
 * stands between it and the money word nearest before it ("fee_count_total", "weight_total",
 * "hours_balance"), not before that word ("energy_cost_total" totals costs).
 */
function totalsAMeasure(ws: readonly string[], at: number, words: ReadonlySet<string> = TOTALLED_WORDS): boolean {
  const money = ws.slice(0, at).map((w) => MONEY_WORDS.has(w) && w !== 'total' && w !== 'totals').lastIndexOf(true);
  return ws.slice(money + 1, at).some((w, i) => words.has(w) && !partOfMoney(ws, money + 1 + i));
}

function judgeWords(all: readonly string[]): Verdict {
  const end = all.at(-1) ?? '';
  // "debit_in_account_currency": the debit is the column; the rest says which currency it is in.
  const inAt = all.indexOf('in');
  if ((end === 'currency' || end === 'ccy') && inAt > 0) return judgeWords(all.slice(0, inAt));
  // "fee_per_txn_bps": a ratio; but "price_per_share": one share is what the price is for (review round 21).
  if (RATIO_WORDS.has(end) && all.includes('per') && !(/^shares?$/.test(end) && all.at(-2) === 'per')) return 'not';
  if (end === 'rate' && PAY_RATE_WORDS.has(all.at(-2) ?? '')) return 'money'; // "hourly_rate": a price of time
  const per = all.indexOf('per');
  if (per === 1 && all[0] === 'rate' && PRICED_UNITS.has(all[2] ?? '')) return 'money'; // "rate_per_hour": a price
  const ws = per > 0 ? all.slice(0, per) : all; // "price_per_month": the price is the column, the month what it is for
  const last = ws.at(-1);
  if (last === undefined) return 'not';
  if (last === 'rate' && PAY_RATE_WORDS.has(ws.at(-2) ?? '')) return 'money'; // "room_rate_per_night" too (review round 22)
  // "nav" is net asset value, money, alone or before a word that says money ("nav_per_share", "nav_usd"); before any
  // other word it is navigation (review round 22: "nav_order"; round 24: "nav_lat" got x100).
  const navNext = all[0] === 'nav' ? all[1] : undefined;
  if (navNext !== undefined && !MONEY_WORDS.has(navNext) && !isUnitWord(navNext) && !NAV_MONEY_WORDS.has(navNext)) return 'not';
  // "amount_minor_units", "amount_in_smallest_unit": the unit of an amount, not a count of units;
  // "price_unit" (Odoo's unit price on every order line): a price per unit.
  const unitOfAmount = (last === 'unit' || last === 'units') && ['minor', 'major', 'smallest', 'lowest', 'price', 'cost'].includes(ws.at(-2) ?? '');
  if (pricesAMeasure(ws)) return 'money'; // "price_kg", "cost_kwh": a price per unit (review round 19)
  if (NOT_MONEY_LAST_WORDS.has(last) && !unitOfAmount) return 'not';
  if ((last === 'value' || last === 'values') && VALUE_WORDS.has(ws.at(-2) ?? '')) return 'money'; // "order_value"
  // A count or measure between the last money word and a final total, balance, budget or allowance says
  // what it holds: "weight_total", "fee_count_total" (round 10), "leave_balance" (round 17), not "energy_cost_total".
  if ((last === 'total' || last === 'totals') && totalsAMeasure(ws, ws.length - 1)) return 'not';
  // The last balance (or bal), budget or allowance anywhere, unless money follows it (round 18: "leave_balance_remaining";
  // round 19: "pto_bal", and what follows it, "balance_hours_remaining"). What it holds is the word right before it
  // (round 20: India's "leave_travel_allowance" is paid in money, as "travel_allowance" is).
  const held = ws.map((w) => /^(?:balance|budget|allowance|bal)s?$/.test(w)).lastIndexOf(true);
  if (held >= 0 && !ws.slice(held + 1).some((w) => MONEY_WORDS.has(w))) {
    const budget = /^budgets?$/.test(ws[held] ?? '');
    // Past words that say its state (round 22: "pto_remaining_balance" got x100); "time off" is leave, as pto is
    // (round 21: time_off_balance, in hours, got x100).
    let at = held - 1;
    while (at >= 0 && HELD_STATE_WORDS.has(ws[at] ?? '')) at -= 1;
    const word = ws[at] === 'off' && ws[at - 1] === 'time' ? 'leave' : (ws[at] ?? '');
    const holds = (words: ReadonlySet<string>) => at >= 0 && words.has(word) && !partOfMoney(ws, at);
    if (holds(budget ? BUDGET_HELD_WORDS : HELD_WORDS) || ws.slice(held + 1).some((w) => HELD_AFTER_WORDS.has(w))) return 'not';
    if (holds(budget ? BUDGET_GUESS_WORDS : HELD_GUESS_WORDS)) return 'guess';
    // A held word further back may be what it holds ("pto_carryover_balance", hours) or not (India's
    // "leave_travel_allowance", money): a guess, so no x100 either way (review round 23).
    if (totalsAMeasure(ws, held, budget ? BUDGET_HELD_WORDS : HELD_WORDS)) return 'guess';
  }
  // A tier's or a level's number kept ("price_tier_1") is sure money with a price; "commission_tier_1" may be a
  // percentage: a guess (review round 23).
  // Without a money word a tier's or a level's number is no money at all (review round 24: "water_level_1" was a guess).
  const tiered = /^\d+$/.test(last) && ['tier', 'level', 'band'].includes(ws.at(-2) ?? '');
  if (tiered && !ws.some((w) => MONEY_WORDS.has(w))) return 'not';
  if (ws.length === 1 && BARE_GUESS_WORDS.has(last)) return 'guess'; // "discount" alone may be a percentage (round 24)
  if (tiered && !ws.some((w) => ['price', 'prices', 'cost', 'costs', 'fee', 'fees', 'amount', 'amounts'].includes(w))) return 'guess';
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
    const unitOfMoney = (w: string, i: number) => (w === 'unit' || w === 'units') && ['minor', 'major', 'smallest', 'lowest'].includes(after[i - 1] ?? '');
    if (after.some((w, i) => GENERIC_MEASURE_WORDS.has(w) || (NOT_MONEY_LAST_WORDS.has(w) && !unitOfMoney(w, i)))) return 'not';
    const before = ws.slice(0, generic).filter((w) => !GENERIC_MONEY_WORDS.has(w));
    return after.every((w, i) => SAYS_MONEY.has(w) || unitOfMoney(w, i)) && before.every((w) => SAYS_MONEY.has(w)) ? 'money' : 'guess';
  }
  if (ws.length !== 1 || last === 'minor') return 'not';
  // A folded name the known words cannot split: the long money words at either end. Total, a generic
  // word, beside words the rule cannot read is a guess ("totalkills", "stepstotal"), as in snake_case.
  const word = withoutUnit(last);
  const ending = FOLDED_MONEY_ENDINGS.find((e) => word.endsWith(e));
  // A held word first and words the rule cannot read before the balance or allowance: a guess, as a held word
  // further back is in snake_case (review round 24: "ptocarryoverbalance", "overtimebankbalance" got x100).
  const heldFirst = (ending === 'balance' || ending === 'allowance') && [...HELD_OWN_WORDS].some((h) => word.startsWith(h) && word.length > h.length + ending.length);
  if (heldFirst) return 'guess';
  if (ending !== undefined) return ending === 'total' && word !== 'total' ? 'guess' : 'money';
  const start = FOLDED_MONEY_ENDINGS.find((s) => word.startsWith(s));
  if (start === undefined || FOLDED_NOT_MONEY_ENDINGS.some((e) => word.endsWith(e))) return 'not';
  return start === 'total' ? 'guess' : 'money';
}


/** A word that says the unit or the currency of an amount, not what it is: "pence", "gbp", "micros". */
function isUnitWord(w: string): boolean {
  return MINOR_UNIT_WORDS.has(w) || UNSURE_UNIT_WORDS.has(w) || FINER_UNIT_WORDS.has(w) || ZERO_DECIMAL_CURRENCIES.has(w) || MORE_DECIMAL_CURRENCIES.has(w) || ['gbp', 'usd', 'eur'].includes(w);
}

/**
 * Whether a name ends in price, cost or fee and then a measure unit, with any unit or currency words left out
 * ("price_kg", review round 19; "price_kwh_pence", "cost_kwh_gbp", "price_pence_kwh", round 20), and a number
 * before the unit ("price_100g", the price of 100 g) and any three-letter word after it, a currency code
 * ("price_kwh_aud", round 21).
 */
function pricesAMeasure(ws: readonly string[]): boolean {
  const rest = ws.filter((w) => !isUnitWord(w) && !/^\d+$/.test(w));
  // Not a word that says what the name is instead (round 22: "price_kg_qty", "cost_kg_pct").
  while (rest.length > 2 && /^[a-z]{3}$/.test(rest.at(-1) ?? '') && !PRICED_MEASURE_WORDS.has(rest.at(-1) ?? '') && !NOT_MONEY_LAST_WORDS.has(rest.at(-1) ?? '')) rest.pop();
  const priced = (a: number, b: number) => PRICED_MEASURE_WORDS.has(rest.at(a) ?? '') && ['price', 'cost', 'fee'].includes(rest.at(b) ?? '');
  return priced(-1, -2) || priced(-2, -1); // "kwh_price", "litre_price" too (round 22)
}

/**
 * Whether a name is the price of one unit ("price_per_kwh", "unit_price", "cost_per_request", "price_unit"): such
 * prices go below a penny, so a float or a numeric with no scale may hold more decimals than a fix keeps (review
 * round 18). A price per night, month, person or seat is not (round 19: price_per_month, salary_per_annum;
 * round 20: price_per_seat); one per hour or day is, as cloud prices are.
 */
export function pricesAUnit(name: string): boolean {
  const ws = knownWords(name);
  const per = ws.indexOf('per');
  return pricesAMeasure(ws) || (per >= 0 && !PER_ORDINARY_WORDS.has(ws[per + 1] ?? '')) || ws.some((w, i) => (w === 'unit' || w === 'units') && ['price', 'cost', 'amount', 'rate', 'fee'].some((m) => ws[i - 1] === m || ws[i + 1] === m));
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
  // A scale other than pounds ("revenue_millions", "amount_k", "amount_x100"): review round 20, where x100 made 12.5 1250.
  // Folded too: "amountx100", "salaryk" (review round 21), a money word and then x or k.
  const raw = words(name);
  const foldedX = (w: string) => w.endsWith('x') && MONEY_WORDS.has(w.slice(0, -1));
  const foldedK = raw.length === 1 && ['k', 'm'].some((e) => (raw[0] ?? '').endsWith(e) && MONEY_WORDS.has((raw[0] ?? '').slice(0, -1))); // "revenuem" too (round 23)
  // "revenue_000", "revenue_gbp_000": the UK's £000 (round 22).
  const thousands = raw.some((w, i) => w === '000' && (i === raw.length - 1 || (i === raw.length - 2 && raw[i + 1] === 's')));
  // "m" after a number is months ("revenue_12m"), not millions (review round 23).
  if (ws.some((w, i) => SCALE_WORDS.has(w) && !(w === 'm' && /^\d+$/.test(ws[i - 1] ?? ''))) || foldedK || thousands || raw.some((w, i) => (w === 'x' || foldedX(w)) && /^10+$/.test(raw[i + 1] ?? ''))) return 'unsure';
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

/**
 * Whether a name is a money word and then currency or ccy ("amount_currency": Odoo's amount in the foreign
 * currency). The name alone says a currency, so it is not money (`looksLikeMoney`); of a number type, it is
 * an amount (review round 22).
 */
export function amountInCurrency(name: string): boolean {
  // Words of which amount it is may stand between: Odoo's "amount_residual_currency" (review round 23).
  const ws = knownWords(name).filter((w) => !['residual', 'foreign', 'original', 'signed', 'company'].includes(w));
  return ['currency', 'ccy'].includes(ws.at(-1) ?? '') && MONEY_WORDS.has(ws.at(-2) ?? '') && !GENERIC_MONEY_WORDS.has(ws.at(-2) ?? '');
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
  perOrdinary: PER_ORDINARY_WORDS,
  budgetGuess: BUDGET_GUESS_WORDS,
  folding: FOLDING_WORDS,
  heldState: HELD_STATE_WORDS,
  scale: SCALE_WORDS,
  navMoney: NAV_MONEY_WORDS,
  bareGuess: BARE_GUESS_WORDS,
};
