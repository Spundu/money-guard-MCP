// Which column names look like money (SPEC.md §3.5). A name looks like money when ANY of its words is a
// money word and its LAST word is not a word that turns it into something else (an id, a date, a
// count, a rate): "amount_due" is money, "amount_currency" and "price_id" are not.

const MONEY_WORDS: ReadonlySet<string> = new Set([
  'amount', 'amounts', 'amt', 'balance', 'balances', 'charge', 'charges', 'cost', 'costs', 'discount',
  'discounts', 'fee', 'fees', 'money', 'payment', 'payments', 'payout', 'payouts', 'pence', 'penny', 'cent',
  'cents', 'minor', 'price', 'prices', 'refund', 'refunds', 'revenue', 'salary', 'salaries', 'subtotal',
  'surcharge', 'tax', 'taxes', 'total', 'totals', 'vat', 'wage', 'wages', 'gbp', 'usd', 'eur',
]);

const NOT_MONEY_LAST_WORDS: ReadonlySet<string> = new Set([
  // identifiers and labels
  'id', 'ids', 'uuid', 'key', 'ref', 'code', 'currency', 'ccy', 'type', 'kind', 'status', 'state', 'method',
  'mode', 'reason', 'note', 'notes', 'description', 'desc', 'label', 'name', 'title', 'text', 'url', 'hash',
  'flag', 'enabled', 'version',
  // dates and times
  'date', 'at', 'on', 'time', 'ts', 'timestamp', 'year', 'month', 'week', 'day', 'days', 'hour', 'hours',
  'minutes', 'seconds', 'ms',
  // counts and order
  'count', 'number', 'num', 'no', 'qty', 'quantity', 'items', 'attempts', 'retries', 'rank', 'tier', 'level',
  'band', 'position', 'priority', 'index', 'seq', 'sequence', 'step', 'stage',
  // rates and measures
  'percent', 'percentage', 'pct', 'rate', 'ratio', 'bps', 'factor', 'multiplier', 'weight', 'score',
  'distance', 'duration', 'km', 'kg',
]);

/** Words that say the column already holds minor units, so a fix must not multiply by 100. */
const MINOR_UNIT_WORDS: ReadonlySet<string> = new Set(['pence', 'penny', 'cent', 'cents', 'minor']);

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

export function looksLikeMoney(name: string): boolean {
  const ws = words(name);
  const last = ws.at(-1);
  return last !== undefined && !NOT_MONEY_LAST_WORDS.has(last) && ws.some((w) => MONEY_WORDS.has(w));
}

/** Whether a money column's name says it holds minor units already ("amount_pence", "totalMinor"). */
export function namesMinorUnits(name: string): boolean {
  const last = words(name).at(-1);
  return last !== undefined && MINOR_UNIT_WORDS.has(last);
}
