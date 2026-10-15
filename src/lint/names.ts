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

const MONEY_WORDS: ReadonlySet<string> = new Set([
  'amount', 'amounts', 'amt', 'balance', 'balances', 'charge', 'charges', 'cost', 'costs', 'discount',
  'discounts', 'fee', 'fees', 'money', 'payment', 'payments', 'payout', 'payouts', 'pence', 'penny',
  'pennies', 'cent', 'cents', 'paise', 'minor', 'price', 'prices', 'refund', 'refunds', 'revenue', 'salary',
  'salaries', 'subtotal', 'surcharge', 'tax', 'taxes', 'total', 'totals', 'vat', 'wage', 'wages', 'gbp',
  'usd', 'eur',
  // ledgers and finance
  'debit', 'debits', 'credit', 'credits', 'net', 'gross', 'commission', 'commissions', 'deposit',
  'deposits', 'interest', 'principal', 'expense', 'expenses', 'income', 'profit', 'profits', 'earnings',
  'budget', 'budgets', 'msrp', 'mrr', 'arr', 'mrp', 'gst', 'cgst', 'sgst', 'igst',
  // pay, commerce and insurance
  'bonus', 'bonuses', 'allowance', 'allowances', 'stipend', 'stipends', 'diem', 'rent', 'rents', 'fare',
  'fares', 'spend', 'premium', 'premiums', 'deductible', 'deductibles', 'donation', 'donations', 'penalty',
  'penalties', 'pnl', 'cogs', 'shipping', 'tip', 'tips', 'pay', 'cashback', 'copay', 'copays', 'reimbursement',
  'reimbursements', 'installment', 'installments', 'instalment', 'instalments', 'dividend', 'dividends', 'royalty',
  'royalties', 'arrears', 'overdraft', 'overdrafts', 'payable', 'payables', 'receivable', 'receivables', 'spending',
  'contribution', 'contributions', 'proceeds', 'postage', 'rrp', 'cash', 'gmv', 'aov', 'arpu', 'notional', 'emi',
  'bal', 'deduction', 'deductions', 'markup', 'markups', 'gratuity', 'gratuities', 'duty', 'duties', 'excise', 'tariff',
  'tariffs', 'brokerage', 'freight', 'toll', 'tolls', 'ltv', 'ebitda', 'severance', 'debt', 'debts',
  // minor units of other currencies
  'paisa', 'kobo', 'sats', 'satoshi', 'satoshis', 'centavo', 'centavos', 'kopek', 'kopeks', 'kopeck',
  'kopecks', 'wei', 'lamport', 'lamports', 'msat', 'msats',
]);

const NOT_MONEY_LAST_WORDS: ReadonlySet<string> = new Set([
  // identifiers and labels
  'id', 'ids', 'uuid', 'key', 'ref', 'code', 'currency', 'ccy', 'type', 'kind', 'status', 'state', 'method',
  'mode', 'reason', 'note', 'notes', 'description', 'desc', 'label', 'name', 'title', 'text', 'url', 'hash',
  'flag', 'enabled', 'version', 'address', 'carrier', 'class', 'intent', 'transaction', 'transactions',
  // dates and times
  'date', 'at', 'on', 'time', 'ts', 'timestamp', 'year', 'years', 'month', 'months', 'week', 'weeks', 'day',
  'days', 'night', 'nights', 'hour', 'hours', 'minutes', 'seconds', 'ms',
  // counts and order: of things, and of people
  'count', 'number', 'num', 'no', 'qty', 'quantity', 'items', 'attempts', 'retries', 'rank', 'ranks', 'tier',
  'tiers', 'level', 'levels', 'band', 'position', 'priority', 'index', 'seq', 'sequence', 'step', 'steps',
  'stage', 'stages', 'unit', 'units', 'orders', 'rooms', 'seats', 'shares', 'guests', 'users', 'members',
  'customers', 'people', 'persons', 'visits', 'views', 'clicks', 'impressions', 'sessions', 'bytes', 'pages', 'rows',
  'hits', 'records', 'lines', 'last', 'first', 'frequency', 'grade', 'schedule', 'cycle',
  // rates and measures
  'percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'weight', 'score', 'share',
  'split', 'distance', 'duration', 'km', 'kg', 'kwh', 'volume', 'points', 'votes', 'miles', 'ml', 'margin',
  'elasticity', 'calories', 'kcal', 'energy', 'lb', 'lbs', 'rating', 'ratings', 'tonnage', 'area', 'size',
  'length', 'width', 'height', 'depth', 'power', 'usage', 'capacity', 'speed', 'temperature', 'precision', 'scale',
  // groupings and terms
  'category', 'categories', 'list', 'lists', 'center', 'centre', 'terms', 'period',
]);

/** Words that say the column already holds minor units, so a fix must not multiply by 100. */
const MINOR_UNIT_WORDS: ReadonlySet<string> = new Set([
  'pence', 'penny', 'pennies', 'cent', 'cents', 'paise', 'paisa', 'kobo', 'sat', 'sats', 'satoshi', 'satoshis',
  'centavo', 'centavos', 'kopek', 'kopeks', 'kopeck', 'kopecks', 'wei', 'lamport', 'lamports', 'msat', 'msats', 'minor',
]);

/**
 * Currencies with no minor unit (ISO 4217 exponent 0): a yen amount is whole yen already, so a fix
 * only rounds.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif', 'clp', 'djf', 'gnf', 'isk', 'jpy', 'kmf', 'krw', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf', 'yen',
]);

/** Units finer than a minor unit ("cost_micros", Google Ads' millionths): the fix needs the unit decided. */
const FINER_UNIT_WORDS: ReadonlySet<string> = new Set(['micros', 'micro', 'millicents', 'millicent', 'mills', 'gwei']);

/**
 * Money words that also start many measures ("total_co2", "net_change", "credit_utilization",
 * "interest_coverage"): they make a name money unless a measure follows them (GENERIC_MEASURE_WORDS, or
 * a non-money last word): "total_paid", "total_deposited", "net_ytd" are money.
 */
const GENERIC_MONEY_WORDS: ReadonlySet<string> = new Set(['total', 'totals', 'net', 'gross', 'credit', 'credits', 'charge', 'charges', 'principal', 'interest']);

const RATIO_WORDS: ReadonlySet<string> = new Set(['percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'score', 'share', 'split']);

/** Words before "rate" that make it the price of a stay, an hour or a mile, which is money: "hourly_rate", "room_rate". */
const PAY_RATE_WORDS: ReadonlySet<string> = new Set([
  'hourly', 'daily', 'nightly', 'night', 'weekly', 'pay', 'day', 'bill', 'billing', 'labor', 'labour', 'room', 'overtime', 'mileage', 'rental', 'hire',
]);

/** What "rate_per_..." can be priced by: "rate_per_hour" is a price; "rate_per_second" stays a rate. */
const PRICED_UNITS: ReadonlySet<string> = new Set(['hour', 'day', 'night', 'week', 'month', 'mile', 'km', 'unit', 'item', 'kg', 'lb', 'person', 'guest', 'visit', 'session']);

/** Words before "value" that make it what something is worth: "order_value", "cart_value". */
const VALUE_WORDS: ReadonlySet<string> = new Set([
  'order', 'orders', 'cart', 'basket', 'invoice', 'contract', 'deal', 'transaction', 'purchase', 'sale', 'sales', 'voucher', 'coupon',
  'gift', 'card', 'item', 'lifetime', 'portfolio', 'inventory', 'stock', 'trade', 'loan', 'asset', 'assets', 'claim', 'policy',
  'market', 'book', 'fair', 'face', 'par', 'line', 'net', 'gross', 'total',
]);

/**
 * Words that often stand beside a money word in a column name, known only to split a folded name
 * ("platformfee" into platform and fee). Words that would also split ordinary words into money words
 * ("work": network; "well": farewell) are kept out.
 */
const OTHER_WORDS: ReadonlySet<string> = new Set([
  'platform', 'service', 'late', 'sales', 'sale', 'base', 'retail', 'wholesale', 'delivery', 'handling', 'processing', 'booking',
  'cancellation', 'setup', 'transfer', 'exchange', 'monthly', 'annual', 'yearly', 'initial', 'final', 'original', 'max', 'min',
  'limit', 'due', 'paid', 'owed', 'outstanding', 'remaining', 'pending', 'grand', 'line', 'item', 'order', 'invoice', 'account',
  'opening', 'closing', 'current', 'available', 'card', 'per', 'in', 'value', 'after', 'before', 'smallest',
  'unit', 'old', 'new', 'prev', 'previous', 'holiday', 'sick', 'overtime', 'take', 'home',
]);

/**
 * Measures that a generic money word can start, beside the non-money last words: "total_co2" (co, 2),
 * "net_change", "credit_utilization", "principal_component_1". Whole words only: they are not used to
 * split folded names.
 */
const GENERIC_MEASURE_WORDS: ReadonlySet<string> = new Set([
  'co', 'ghg', 'carbon', 'emissions', 'reps', 'carbs', 'protein', 'fat', 'sugar', 'latency', 'memory', 'cpu', 'ram', 'disk',
  'storage', 'bandwidth', 'tokens', 'errors', 'failures', 'requests', 'calls', 'events', 'messages', 'downloads', 'files',
  'tasks', 'jobs', 'runs', 'tests', 'cases', 'deaths', 'population', 'words', 'chars', 'characters', 'likes', 'followers',
  'rainfall', 'change', 'changes', 'flow', 'flows', 'utilization', 'utilisation', 'component', 'components', 'coverage',
  'axis', 'investigator',
]);

/**
 * Money words long enough to find at the end of a folded one-word name. The short ones (fee, tax, vat,
 * cent, charge) are left out: they also end coffee, syntax, percent and discharge.
 */
const FOLDED_MONEY_ENDINGS = ['amount', 'balance', 'cost', 'payment', 'payout', 'price', 'refund', 'revenue', 'salary', 'subtotal', 'surcharge', 'total'];

/**
 * Unit words that can follow the money word in a folded name ("amountminor", "totalpennies"), longest
 * first. The short ones (cent, sat, wei) are left out: they also end percent and other words.
 */
const FOLDED_UNIT_ENDINGS = [...MINOR_UNIT_WORDS, ...FINER_UNIT_WORDS].filter((w) => !['cent', 'sat', 'wei'].includes(w)).sort((a, b) => b.length - a.length);

/** Non-money last words long enough to find at the end of a folded name ("totalcount", "pricelist"). */
const FOLDED_NOT_MONEY_ENDINGS = [...NOT_MONEY_LAST_WORDS].filter((w) => w.length >= 4);

/** A folded one-word name ("totalamount", "amountminor") without its unit ending, if it has one. */
function withoutUnit(word: string): string {
  const unit = FOLDED_UNIT_ENDINGS.find((u) => word.length > u.length && word.endsWith(u));
  return unit === undefined ? word : word.slice(0, -unit.length);
}

/** Every word the rule knows, to split a folded name by. */
const VOCABULARY: ReadonlySet<string> = new Set([
  ...MONEY_WORDS, ...NOT_MONEY_LAST_WORDS, ...MINOR_UNIT_WORDS, ...FINER_UNIT_WORDS, ...RATIO_WORDS, ...PAY_RATE_WORDS, ...PRICED_UNITS, ...VALUE_WORDS, ...OTHER_WORDS,
]);

/**
 * A folded name split into known words, in as few as can be ("totaldiscount": total + discount, not
 * total + dis + count); undefined when it cannot be split entirely into known words.
 */
function split(word: string): string[] | undefined {
  const best: Array<string[] | undefined> = [[]]; // best[i]: the fewest words that make up word[0, i)
  for (let end = 1; end <= word.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      const head = best[start];
      if (head === undefined || !VOCABULARY.has(word.slice(start, end))) continue;
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

export function looksLikeMoney(name: string): boolean {
  return judgeWords(knownWords(name));
}

function judgeWords(all: readonly string[]): boolean {
  const end = all.at(-1) ?? '';
  // "debit_in_account_currency": the debit is the column; the rest says which currency it is in.
  const inAt = all.indexOf('in');
  if ((end === 'currency' || end === 'ccy') && inAt > 0) return judgeWords(all.slice(0, inAt));
  if (RATIO_WORDS.has(end) && all.includes('per')) return false; // "fee_per_txn_bps": a ratio
  if (end === 'rate' && PAY_RATE_WORDS.has(all.at(-2) ?? '')) return true; // "hourly_rate": a price of time
  const per = all.indexOf('per');
  if (per === 1 && all[0] === 'rate' && PRICED_UNITS.has(all[2] ?? '')) return true; // "rate_per_hour": a price
  const ws = per > 0 ? all.slice(0, per) : all; // "price_per_month": the price is the column, the month what it is for
  const last = ws.at(-1);
  if (last === undefined) return false;
  // "amount_minor_units", "amount_in_smallest_unit": the unit of an amount, not a count of units;
  // "price_unit" (Odoo's unit price on every order line): a price per unit.
  const unitOfAmount = (last === 'unit' || last === 'units') && ['minor', 'smallest', 'price', 'cost'].includes(ws.at(-2) ?? '');
  if (NOT_MONEY_LAST_WORDS.has(last) && !unitOfAmount) return false;
  if ((last === 'value' || last === 'values') && VALUE_WORDS.has(ws.at(-2) ?? '')) return true; // "order_value"
  // "minor" says the unit of an amount beside another money word ("amount_minor"); beside a version it
  // is a version part ("version_minor"); alone, or with unit ("minor_unit", ISO 4217's currency
  // exponent), it is not an amount.
  if (ws.some((w) => MONEY_WORDS.has(w) && w !== 'minor' && !GENERIC_MONEY_WORDS.has(w))) return true;
  // A generic money word counts unless a measure follows it: "total_paid" and "net_ytd" are money,
  // "total_co2" and "credit_utilization" measures. "units" after minor or smallest is the unit of the money.
  const generic = ws.map((w) => GENERIC_MONEY_WORDS.has(w)).lastIndexOf(true);
  if (generic >= 0) {
    return !ws.slice(generic + 1).some((w, i, after) => GENERIC_MEASURE_WORDS.has(w) || (NOT_MONEY_LAST_WORDS.has(w) && !((w === 'unit' || w === 'units') && ['minor', 'smallest'].includes(after[i - 1] ?? ''))));
  }
  if (ws.length !== 1 || last === 'minor') return false;
  // A folded name the known words cannot split: the long money words at either end.
  const word = withoutUnit(last);
  if (FOLDED_MONEY_ENDINGS.some((ending) => word.endsWith(ending))) return true;
  return FOLDED_MONEY_ENDINGS.some((start) => word.startsWith(start)) && !FOLDED_NOT_MONEY_ENDINGS.some((ending) => word.endsWith(ending));
}

/**
 * Unit words that also mean something else: "price_sat" may be Saturday's price, "price_minor" a
 * child's, "amount_won" Korean won (no minor unit) or a prize.
 */
const UNSURE_UNIT_WORDS: ReadonlySet<string> = new Set(['sat', 'minor', 'won']);

/**
 * What a money column's name says about its unit: "minor" when it says minor units plainly (a
 * minor-unit word: "amount_pence", "price_cents_usd", "amount_sats"; "minor" or "smallest" before unit
 * or units: "amount_minor_units", "amount_in_smallest_unit"; a currency with no minor unit:
 * "amount_jpy"); "unsure" when it holds a word that may mean minor units or something else
 * ("amount_minor", "price_minor", "price_sat") or a unit finer than a minor unit ("cost_micros",
 * "price_gwei"): a fix needs that decided first; "major" otherwise.
 */
export function unitOfName(name: string): 'minor' | 'major' | 'unsure' {
  const ws = knownWords(name);
  if (ws.some((w) => FINER_UNIT_WORDS.has(w))) return 'unsure';
  const unitAfter = (i: number) => ws[i + 1] === 'unit' || ws[i + 1] === 'units';
  if (ws.some((w, i) => (w === 'minor' || w === 'smallest') && unitAfter(i))) return 'minor';
  if (ws.some((w) => MINOR_UNIT_WORDS.has(w) && !UNSURE_UNIT_WORDS.has(w))) return 'minor';
  if (ws.some((w) => UNSURE_UNIT_WORDS.has(w))) return 'unsure';
  if (ws.some((w) => ZERO_DECIMAL_CURRENCIES.has(w))) return 'minor'; // whole yen are its smallest unit
  // A folded name the known words cannot split, ending in a unit word ("grossamountpence").
  const only = ws.length === 1 ? ws[0] : undefined;
  if (only === undefined || withoutUnit(only) === only) return 'major';
  const ending = only.slice(withoutUnit(only).length);
  return UNSURE_UNIT_WORDS.has(ending) || FINER_UNIT_WORDS.has(ending) ? 'unsure' : 'minor';
}

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
};

/** The words of the prose rules of SPEC.md §3.5, which must all appear there. */
export const RULE_WORDS: readonly string[] = [...RATIO_WORDS, ...PAY_RATE_WORDS, ...PRICED_UNITS, ...VALUE_WORDS];
