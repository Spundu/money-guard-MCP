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

/** Counts, of things and of people: the non-money last words that also say what a total counts. */
const COUNT_WORDS: ReadonlySet<string> = new Set([
  'count', 'number', 'num', 'qty', 'quantity', 'attempts', 'retries', 'unit', 'units', 'rooms', 'seats', 'shares',
  'guests', 'users', 'members', 'customers', 'people', 'persons', 'visits', 'views', 'clicks', 'impressions',
  'sessions', 'bytes', 'pages', 'rows', 'hits',
]);

/** Rates and measures: the non-money last words that also say what a total measures. */
const MEASURE_WORDS: ReadonlySet<string> = new Set([
  'percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'weight', 'score', 'share',
  'split', 'distance', 'duration', 'km', 'kg', 'g', 'mg', 'kwh', 'volume', 'points', 'votes', 'miles', 'ml', 'margin',
  'elasticity', 'calories', 'kcal', 'energy', 'lb', 'lbs', 'rating', 'ratings', 'tonnage', 'area', 'size',
  'length', 'width', 'height', 'depth', 'power', 'usage', 'capacity', 'speed', 'temperature', 'precision', 'scale',
  'growth',
]);

const NOT_MONEY_LAST_WORDS: ReadonlySet<string> = new Set([
  // identifiers and labels
  'id', 'ids', 'uuid', 'key', 'ref', 'code', 'currency', 'ccy', 'type', 'kind', 'status', 'state', 'method',
  'mode', 'reason', 'note', 'notes', 'description', 'desc', 'label', 'name', 'title', 'text', 'url', 'hash',
  'flag', 'enabled', 'version', 'address', 'carrier', 'class', 'intent', 'transaction', 'transactions', 'subnet', 'subnets',
  // dates and times
  'date', 'at', 'on', 'time', 'ts', 'timestamp', 'year', 'years', 'month', 'months', 'week', 'weeks', 'day',
  'days', 'night', 'nights', 'hour', 'hours', 'minutes', 'seconds', 'ms',
  ...COUNT_WORDS,
  // order, and things that have a price ("line_items_total" is money; "total_items" a count)
  'no', 'items', 'rank', 'ranks', 'tier', 'tiers', 'level', 'levels', 'band', 'position', 'priority', 'index', 'seq',
  'sequence', 'step', 'steps', 'stage', 'stages', 'orders', 'records', 'lines', 'last', 'first', 'frequency', 'grade',
  'schedule', 'cycle',
  ...MEASURE_WORDS,
  // groupings and terms
  'category', 'categories', 'list', 'lists', 'center', 'centre', 'terms', 'period',
]);

/** Words that say the column already holds minor units, so a fix must not multiply by 100. */
const MINOR_UNIT_WORDS: ReadonlySet<string> = new Set([
  'pence', 'penny', 'pennies', 'cent', 'cents', 'paise', 'paisa', 'kobo', 'sat', 'sats', 'satoshi', 'satoshis',
  'centavo', 'centavos', 'kopek', 'kopeks', 'kopeck', 'kopecks', 'wei', 'lamport', 'lamports', 'msat', 'msats', 'minor',
  'subunit', 'subunits', 'pesewa', 'pesewas', 'halala', 'halalas', 'fils', 'agora', 'agorot', 'centime', 'centimes', 'rappen',
  'grosz', 'groszy', 'stotinka', 'stotinki', 'santim', 'santims', 'kurus',
]);

/**
 * Unit words that also mean something else: "price_sat" may be Saturday's price, "price_minor" a
 * child's, "amount_won" Korean won (no minor unit) or a prize; "total_ore" may be öre or iron ore,
 * "price_fen" and "price_sen" fen and sen or something else.
 */
const UNSURE_UNIT_WORDS: ReadonlySet<string> = new Set(['sat', 'minor', 'won', 'ore', 'fen', 'sen']);

/**
 * Currencies with no minor unit (ISO 4217 exponent 0): a yen amount is whole yen already, so a fix
 * only rounds.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif', 'clp', 'djf', 'gnf', 'isk', 'jpy', 'kmf', 'krw', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf', 'yen',
]);

/**
 * Currencies with more than two decimals (ISO 4217 exponent 3, and 4 for CLF and UYW; crypto coins, 8 or
 * 18): a dinar has 1,000 fils, so x100 is wrong, and whether the column holds dinars or fils needs a
 * decision. x100 of 0.00012345 BTC, rounded, was 0 (review round 10).
 */
const MORE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bhd', 'iqd', 'jod', 'kwd', 'lyd', 'omr', 'tnd', 'clf', 'uyw', 'btc', 'xbt', 'eth', 'sol', 'usdc', 'usdt', 'dai', 'ltc', 'xrp', 'ada', 'doge', 'bnb',
]);

/** Units finer than a minor unit ("cost_micros", Google Ads' millionths): the fix needs the unit decided. */
const FINER_UNIT_WORDS: ReadonlySet<string> = new Set(['micros', 'micro', 'millicents', 'millicent', 'mills', 'millis', 'gwei']);

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
  'opening', 'closing', 'current', 'available', 'card', 'per', 'in', 'value', 'after', 'before', 'smallest', 'lowest', 'denomination',
  'unit', 'old', 'new', 'prev', 'previous', 'holiday', 'sick', 'overtime', 'take', 'home', 'sub', 'cart', 'basket', 'running', 'store',
  'refunded', 'invoiced', 'charged', 'billed', 'spent', 'earned', 'collected', 'withdrawn', 'deposited', 'accrued', 'credited', 'debited', 'settled', 'disbursed', 'reimbursed', 'received',
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
  'axis', 'investigator', 'meters', 'metres', 'liters', 'litres', 'tons', 'tonnes', 'grams', 'mass', 'force', 'torque',
  'heat', 'flux', 'runtime', 'uptime', 'xp', 'damage', 'mins', 'hrs', 'secs', 'kw', 'mb', 'gb', 'bmi', 'goals', 'wins',
  'players', 'mileage', 'current', 'voltage', 'amps', 'watts',
]);

/**
 * What a total before it can count or measure: "weight_total" is "total_weight", "hours_total" and
 * "credit_score_total" are not money. Not unit, units or margin: "units_total" (Sylius) and
 * "margin_total" are money. Only for total and totals: what a charge is for may be a measure
 * ("usage_charge" is money).
 */
const TOTALLED_WORDS: ReadonlySet<string> = new Set(
  [...COUNT_WORDS, ...MEASURE_WORDS, ...GENERIC_MEASURE_WORDS, 'days', 'nights', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds', 'ms'].filter(
    (w) => !['unit', 'units', 'margin', 'current'].includes(w), // current_total: this period's (review round 11)
  ),
);

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

/**
 * Every word the rule knows, to split a folded name by; the unit words too, so that "amountjpy" (an
 * unquoted AmountJPY) gets the unit "amount_jpy" gets.
 */
const VOCABULARY: ReadonlySet<string> = new Set([
  ...MONEY_WORDS, ...NOT_MONEY_LAST_WORDS, ...MINOR_UNIT_WORDS, ...UNSURE_UNIT_WORDS, ...ZERO_DECIMAL_CURRENCIES, ...MORE_DECIMAL_CURRENCIES,
  ...FINER_UNIT_WORDS, ...RATIO_WORDS, ...PAY_RATE_WORDS, ...PRICED_UNITS, ...VALUE_WORDS, ...OTHER_WORDS,
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

/**
 * Whether the total at `at` totals a count or a measure: one of those stands between it and the money
 * word nearest before it ("fee_count_total", "weight_total"), not before that word ("energy_cost_total",
 * "usage_charge_total" total costs and charges).
 */
function totalsAMeasure(ws: readonly string[], at: number): boolean {
  const money = ws.slice(0, at).map((w) => MONEY_WORDS.has(w) && w !== 'total' && w !== 'totals').lastIndexOf(true);
  return ws.slice(money + 1, at).some((w) => TOTALLED_WORDS.has(w));
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
  if (NOT_MONEY_LAST_WORDS.has(last) && !unitOfAmount) return 'not';
  if ((last === 'value' || last === 'values') && VALUE_WORDS.has(ws.at(-2) ?? '')) return 'money'; // "order_value"
  // A count or measure between the last money word and a final total says what it totals:
  // "weight_total", and "fee_count_total" is a count of fees (review round 10); "energy_cost_total" is a
  // total of costs (review round 11).
  if ((last === 'total' || last === 'totals') && totalsAMeasure(ws, ws.length - 1)) return 'not';
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
};
