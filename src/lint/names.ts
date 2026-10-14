// Which column names look like money (SPEC.md §3.5). A name looks like money when ANY of its words is a
// money word and its LAST word is not a word that turns it into something else (an id, a date, a
// count, a rate): "amount_due" is money, "amount_currency" and "price_id" are not. Words after "per"
// only say what the amount is for ("price_per_month" is money), and a one-word name that PostgreSQL
// folded to lowercase ("TotalAmount" became "totalamount") is money when it ends in a long money word.

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
  'distance', 'duration', 'km', 'kg', 'kwh', 'volume', 'points', 'votes',
]);

/** Words that say the column already holds minor units, so a fix must not multiply by 100. */
const MINOR_UNIT_WORDS: ReadonlySet<string> = new Set(['pence', 'penny', 'cent', 'cents', 'minor']);

/**
 * Money words long enough to find at the end of a folded one-word name. The short ones (fee, tax, vat,
 * cent, charge) are left out: they also end coffee, syntax, percent and discharge.
 */
const FOLDED_MONEY_ENDINGS = ['amount', 'balance', 'cost', 'payment', 'payout', 'price', 'refund', 'revenue', 'salary', 'subtotal', 'surcharge', 'total'];

/** Unit words that can follow the money word in a folded name: "amountminor", "totalpence". */
const FOLDED_UNIT_ENDINGS = ['minor', 'pence', 'cents'];

/** A folded one-word name ("totalamount", "amountminor") without its unit ending, if it has one. */
function withoutUnit(word: string): string {
  const unit = FOLDED_UNIT_ENDINGS.find((u) => word.length > u.length && word.endsWith(u));
  return unit === undefined ? word : word.slice(0, -unit.length);
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

export function looksLikeMoney(name: string): boolean {
  let ws = words(name);
  const per = ws.indexOf('per');
  if (per > 0) ws = ws.slice(0, per); // "price_per_month": the price is the column, the month what it is for
  const last = ws.at(-1);
  if (last === undefined || NOT_MONEY_LAST_WORDS.has(last)) return false;
  if (ws.length === 1 && last === 'minor') return false; // a version number (major, minor, patch)
  if (ws.some((w) => MONEY_WORDS.has(w))) return true;
  return ws.length === 1 && FOLDED_MONEY_ENDINGS.some((ending) => withoutUnit(last).endsWith(ending));
}

/**
 * Whether a money column's name says it holds minor units already: a minor-unit word anywhere
 * ("amount_pence", "price_cents_usd", "amount_minor_units", "totalMinor"), or a folded name ending in one
 * ("amountminor").
 */
export function namesMinorUnits(name: string): boolean {
  const ws = words(name);
  if (ws.some((w) => MINOR_UNIT_WORDS.has(w))) return true;
  const only = ws.length === 1 ? ws[0] : undefined;
  return only !== undefined && withoutUnit(only) !== only;
}
