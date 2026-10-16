// The word lists of the money-name rule (SPEC.md §3.5), which src/lint/names.ts applies. Split from it,
// which grew past 400 lines (review round 18).

export const MONEY_WORDS: ReadonlySet<string> = new Set([
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
  'contribution', 'contributions', 'proceeds', 'postage', 'rrp', 'cash', 'gmv', 'aov', 'arpu', 'notional', 'emi', 'nav',
  'bal', 'bals', 'deduction', 'deductions', 'markup', 'markups', 'gratuity', 'gratuities', 'duty', 'duties', 'excise', 'tariff',
  'tariffs', 'brokerage', 'freight', 'toll', 'tolls', 'ltv', 'ebitda', 'severance', 'debt', 'debts',
  // minor units of other currencies
  'paisa', 'kobo', 'sats', 'satoshi', 'satoshis', 'centavo', 'centavos', 'kopek', 'kopeks', 'kopeck',
  'kopecks', 'wei', 'lamport', 'lamports', 'msat', 'msats',
]);

/** Counts, of things and of people: the non-money last words that also say what a total counts. */
export const COUNT_WORDS: ReadonlySet<string> = new Set([
  'count', 'number', 'num', 'qty', 'quantity', 'attempts', 'retries', 'unit', 'units', 'rooms', 'seats', 'shares',
  'guests', 'users', 'members', 'customers', 'people', 'persons', 'visits', 'views', 'clicks', 'impressions',
  'sessions', 'bytes', 'pages', 'rows', 'hits',
]);

/** Rates and measures: the non-money last words that also say what a total measures. */
export const MEASURE_WORDS: ReadonlySet<string> = new Set([
  'percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'weight', 'score', 'share',
  'split', 'distance', 'duration', 'km', 'kg', 'g', 'mg', 'kwh', 'volume', 'points', 'votes', 'miles', 'ml', 'margin',
  'elasticity', 'calories', 'kcal', 'energy', 'lb', 'lbs', 'rating', 'ratings', 'tonnage', 'area', 'size',
  'length', 'width', 'height', 'depth', 'power', 'usage', 'capacity', 'speed', 'temperature', 'precision', 'scale',
  'growth',
]);

export const NOT_MONEY_LAST_WORDS: ReadonlySet<string> = new Set([
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
export const MINOR_UNIT_WORDS: ReadonlySet<string> = new Set([
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
export const UNSURE_UNIT_WORDS: ReadonlySet<string> = new Set(['sat', 'minor', 'won', 'ore', 'fen', 'sen']);

/**
 * Currencies with no minor unit (ISO 4217 exponent 0): a yen amount is whole yen already, so a fix
 * only rounds.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif', 'clp', 'djf', 'gnf', 'isk', 'jpy', 'kmf', 'krw', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf', 'yen',
]);

/**
 * Currencies with more than two decimals (ISO 4217 exponent 3, and 4 for CLF and UYW; crypto coins, 8 or
 * 18): a dinar has 1,000 fils, so x100 is wrong, and whether the column holds dinars or fils needs a
 * decision. x100 of 0.00012345 BTC, rounded, was 0 (review round 10).
 */
export const MORE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bhd', 'iqd', 'jod', 'kwd', 'lyd', 'omr', 'tnd', 'clf', 'uyw', 'btc', 'xbt', 'eth', 'sol', 'usdc', 'usdt', 'dai', 'ltc', 'xrp', 'ada', 'doge', 'bnb',
]);

/** Units finer than a minor unit ("cost_micros", Google Ads' millionths): the fix needs the unit decided. */
export const FINER_UNIT_WORDS: ReadonlySet<string> = new Set(['micros', 'micro', 'millicents', 'millicent', 'mills', 'millis', 'gwei']);

/**
 * Money words that also start many measures ("total_co2", "net_change", "credit_utilization",
 * "interest_coverage"): they make a name money unless a measure follows them (GENERIC_MEASURE_WORDS, or
 * a non-money last word): "total_paid", "total_deposited", "net_ytd" are money.
 */
export const GENERIC_MONEY_WORDS: ReadonlySet<string> = new Set(['total', 'totals', 'net', 'gross', 'credit', 'credits', 'charge', 'charges', 'principal', 'interest']);

export const RATIO_WORDS: ReadonlySet<string> = new Set(['percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'score', 'share', 'split']);

/** Words before "rate" that make it the price of a stay, an hour or a mile, which is money: "hourly_rate", "room_rate". */
export const PAY_RATE_WORDS: ReadonlySet<string> = new Set([
  'hourly', 'daily', 'nightly', 'night', 'weekly', 'pay', 'day', 'bill', 'billing', 'labor', 'labour', 'room', 'overtime', 'mileage', 'rental', 'hire', 'diem',
  'hour', 'cost', 'costing', 'valuation', 'incoming', 'unit', // ERPNext, Harvest and energy tariffs (review round 21)
]);

/** What "rate_per_..." can be priced by: "rate_per_hour" is a price; "rate_per_second" stays a rate. */
export const PRICED_UNITS: ReadonlySet<string> = new Set(['hour', 'day', 'night', 'week', 'month', 'mile', 'km', 'unit', 'item', 'kg', 'lb', 'person', 'guest', 'visit', 'session', 'kwh', 'gb', 'litre', 'liter']);

/** Words before "value" that make it what something is worth: "order_value", "cart_value". */
export const VALUE_WORDS: ReadonlySet<string> = new Set([
  'order', 'orders', 'cart', 'basket', 'invoice', 'contract', 'deal', 'transaction', 'purchase', 'sale', 'sales', 'voucher', 'coupon',
  'gift', 'card', 'item', 'lifetime', 'portfolio', 'inventory', 'stock', 'trade', 'loan', 'asset', 'assets', 'claim', 'policy',
  'market', 'book', 'fair', 'face', 'par', 'line', 'net', 'gross', 'total',
]);

/**
 * Words that often stand beside a money word in a column name, known only to split a folded name
 * ("platformfee" into platform and fee). Words that would also split ordinary words into money words
 * ("work": network; "well": farewell) are kept out.
 */
export const OTHER_WORDS: ReadonlySet<string> = new Set([
  'platform', 'service', 'late', 'sales', 'sale', 'base', 'retail', 'wholesale', 'delivery', 'handling', 'processing', 'booking',
  'cancellation', 'setup', 'transfer', 'exchange', 'monthly', 'annual', 'yearly', 'initial', 'final', 'original', 'max', 'min',
  'limit', 'due', 'paid', 'owed', 'outstanding', 'remaining', 'pending', 'grand', 'line', 'item', 'order', 'invoice', 'account',
  'opening', 'closing', 'current', 'available', 'card', 'per', 'in', 'value', 'after', 'before', 'smallest', 'lowest', 'denomination',
  'unit', 'old', 'new', 'prev', 'previous', 'holiday', 'sick', 'overtime', 'take', 'home', 'sub', 'cart', 'basket', 'running', 'store',
  'refunded', 'invoiced', 'charged', 'billed', 'spent', 'earned', 'collected', 'withdrawn', 'deposited', 'accrued', 'credited', 'debited', 'settled', 'disbursed', 'reimbursed', 'received',
]);

/**
 * Measures that a generic money word can start, beside the non-money last words: "total_co2" (co, 2),
 * "net_change", "credit_utilization", "principal_component_1". Since review round 20 they also split folded
 * names ("totalflow" is total + flow).
 */
export const GENERIC_MEASURE_WORDS: ReadonlySet<string> = new Set([
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
export const TOTALLED_WORDS: ReadonlySet<string> = new Set(
  [...COUNT_WORDS, ...MEASURE_WORDS, ...GENERIC_MEASURE_WORDS, 'days', 'nights', 'weeks', 'months', 'years', 'hours', 'minutes', 'seconds', 'ms'].filter(
    (w) => !['unit', 'units', 'margin', 'current'].includes(w), // current_total: this period's (review round 11)
  ),
);

/**
 * Money words long enough to find at the end of a folded one-word name. The short ones (fee, tax, vat,
 * cent, charge) are left out: they also end coffee, syntax, percent and discharge.
 */
export const FOLDED_MONEY_ENDINGS = ['amount', 'allowance', 'balance', 'cost', 'payment', 'payout', 'price', 'refund', 'revenue', 'salary', 'subtotal', 'surcharge', 'total'];

/**
 * Unit words that can follow the money word in a folded name ("amountminor", "totalpennies"), longest
 * first. The short ones (cent, sat, wei) are left out: they also end percent and other words.
 */
export const FOLDED_UNIT_ENDINGS = [...MINOR_UNIT_WORDS, ...FINER_UNIT_WORDS].filter((w) => !['cent', 'sat', 'wei'].includes(w)).sort((a, b) => b.length - a.length);

/** Non-money last words long enough to find at the end of a folded name ("totalcount", "pricelist"). */
export const FOLDED_NOT_MONEY_ENDINGS = [...NOT_MONEY_LAST_WORDS].filter((w) => w.length >= 4);

/** What a balance, budget or allowance holds when it is not money: time off, errors, baggage (review round 17). */
export const HELD_OWN_WORDS: ReadonlySet<string> = new Set(['leave', 'holiday', 'holidays', 'pto', 'vacation', 'sick', 'error', 'baggage', 'luggage', 'mass', 'fluid', 'calorie', 'token', 'point', 'overtime', 'flexi', 'flexitime', 'toil']);

/** What it may hold either way: an inventory balance is money in accounting, a data allowance is not (review round 18). */
export const HELD_GUESS_WORDS: ReadonlySet<string> = new Set(['stock', 'inventory', 'data', 'time', 'mileage']); // a mileage allowance is paid in pence per mile (round 19)
/** The same for a budget. */
export const BUDGET_GUESS_WORDS: ReadonlySet<string> = new Set(['data', 'mileage']);

/**
 * What a balance, budget or allowance holds when one of these follows it: "balance_hours_remaining",
 * "allowance_days_left", "budget_tokens_remaining" (review round 19). Not every measure: "balance_change" is money.
 */
export const HELD_AFTER_WORDS: ReadonlySet<string> = new Set(['hours', 'hrs', 'days', 'nights', 'weeks', 'months', 'years', 'minutes', 'mins', 'seconds', 'secs', 'tokens', 'points', 'leave', 'holiday', 'holidays', 'pto', 'vacation', 'sick']);

/**
 * A budget is money unless it is of computing or time (review round 18: holiday and stock budgets are money).
 * Round 19: the time words of a budget in days or hours ("pto_days_budget"), not "day" or "month" ("month_budget" is money).
 */
export const BUDGET_OWN_WORDS: ReadonlySet<string> = new Set(['error', 'token', 'calorie', 'calories', 'time', 'hour', 'hours', 'hrs', 'minute', 'minutes', 'mins', 'second', 'seconds', 'secs', 'ms', 'days', 'nights', 'weeks']);

/**
 * What a price "per" a stay, a period or a person is for: an ordinary price, not below a penny (review round 19).
 * Not an hour or a day (round 20: cloud prices per hour are fractions of a penny), nor a request or a unit.
 */
export const PER_ORDINARY_WORDS: ReadonlySet<string> = new Set([
  'night', 'nights', 'week', 'weeks', 'month', 'months', 'year', 'years', 'annum', 'quarter', 'person', 'guest', 'stay', 'visit',
  'seat', 'seats', 'user', 'users', 'ticket', 'license', 'licence', 'order', 'employee', 'member', 'room', 'adult', 'child', 'student',
]);

/** The measure units a price can be given per without "per": "price_kg", "cost_kwh", "fuel_price_litre" (review round 19). */
export const PRICED_MEASURE_WORDS: ReadonlySet<string> = new Set(['kg', 'g', 'mg', 'lb', 'km', 'mile', 'kwh', 'ml', 'litre', 'liter', 'gb', 'mb']);

/** A scale other than pounds: "revenue_millions", "amount_k" hold thousands or millions of pounds (review round 20). */
export const SCALE_WORDS: ReadonlySet<string> = new Set(['k', 'thousand', 'thousands', 'mm', 'million', 'millions', 'bn', 'billion', 'billions', 'lakh', 'lakhs', 'crore', 'crores', 'hundredths']);

/**
 * Words only for splitting folded names: what an -ing name may start with ("marketingbudget", review round 18), and
 * "real", "left" and "off" ("realtimebalance", "allowancedaysleft", "timeoffbalance" as their snake_case forms,
 * rounds 20 and 21).
 */
export const FOLDING_WORDS: ReadonlySet<string> = new Set(['marketing', 'listing', 'advertising', 'parking', 'packaging', 'training', 'funding', 'real', 'left', 'off']);
