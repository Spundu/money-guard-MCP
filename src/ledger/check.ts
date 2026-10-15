// money_check_double_entry's rules (SPEC.md §4.5): integer-pence-ledger's posting rules (at least two
// legs, no leg that moves nothing, whole minor units, legs netting to zero), applied to every
// transaction of an export, returning every problem instead of throwing at the first.

import { clip, cut, escapeUnsafe } from '../echo.js';
import { ToolError } from '../errors.js';
import { parseAmount, type AmountFormat } from '../money.js';
import { JsonNumber, plainDecimal } from './json.js';
import type { ColumnMap, LedgerRow, MappedField } from './read.js';

export type Mode = 'signed' | 'side' | 'debit_credit';

export type FindingCode =
  | 'UNBALANCED'
  | 'TOO_FEW_LEGS'
  | 'ZERO_LEG'
  | 'MISSING_VALUE'
  | 'BAD_AMOUNT'
  | 'FRACTIONAL_MINOR_UNITS'
  | 'AMOUNT_TOO_LARGE'
  | 'BAD_SIDE'
  | 'NEGATIVE_WITH_SIDE'
  | 'BAD_ROW';

/** The SPEC.md §4.5 table order: how findings on the same row are sorted. */
const CODE_ORDER: readonly FindingCode[] = ['UNBALANCED', 'TOO_FEW_LEGS', 'ZERO_LEG', 'MISSING_VALUE', 'BAD_AMOUNT', 'FRACTIONAL_MINOR_UNITS', 'AMOUNT_TOO_LARGE', 'BAD_SIDE', 'NEGATIVE_WITH_SIDE', 'BAD_ROW'];

export interface Net {
  currency: string | null;
  /** Integer minor units, as a string: exact at any size. */
  net: string;
}

export interface Finding {
  code: FindingCode;
  severity: 'error' | 'warning';
  transaction_id: string | null;
  lines?: number[];
  pointers?: string[];
  more_rows?: number;
  field?: string;
  value?: string;
  nets?: Net[];
  message: string;
}

export interface CheckOptions {
  amountFormat: AmountFormat;
  decimalPlaces: number;
}

export interface CheckOutcome {
  /** The first MAX_LISTED_FINDINGS findings, sorted by first location, then code. */
  findings: Finding[];
  /** Every finding counted: in all, by severity, by code, and those without a transaction. */
  counts: { total: number; errors: number; warnings: number; byCode: Partial<Record<FindingCode, number>>; withoutTransaction: number };
  /** Amounts written with a decimal point, and non-zero amounts written without one: together they show a file of pounds read as pence. */
  amounts: { decimalPoint: number; plain: number };
  rowsRead: number;
  transactionsFound: number;
  transactionsNotChecked: number;
  transactionsBalanced: number;
}

/**
 * At most this many findings are kept, the first in order, for the result's pages (SPEC.md §4.8); every
 * finding is still counted. A hostile file can make three findings a row: keeping all three million
 * took 1.7 GB.
 */
export const MAX_LISTED_FINDINGS = 10_000;

type Ordered = Finding & { order: number };

/** A finding's place in the sort: its first row, then the SPEC.md §4.5 code order. */
function rank(f: Ordered): number {
  return f.order * CODE_ORDER.length + CODE_ORDER.indexOf(f.code);
}

/**
 * The first `max` findings in sort order, kept while findings arrive in any order, in memory bounded by
 * twice `max`; and a count of every finding. A finding that ranks after the last of a full list is only
 * counted. Ties keep their arrival order, as the stable sort did.
 */
class FirstFindings {
  readonly counts: CheckOutcome['counts'] = { total: 0, errors: 0, warnings: 0, byCode: {}, withoutTransaction: 0 };
  #kept: Ordered[] = [];
  #after = Number.POSITIVE_INFINITY; // a full list holds nothing that ranks after this
  #firstRank = new Map<FindingCode, number>(); // where each code first appears in the sort

  constructor(private readonly max: number) {}

  add(f: Ordered): void {
    const c = this.counts;
    c.total += 1;
    if (f.severity === 'error') c.errors += 1;
    else c.warnings += 1;
    c.byCode[f.code] = (c.byCode[f.code] ?? 0) + 1;
    if (f.transaction_id === null) c.withoutTransaction += 1;
    const r = rank(f);
    if (r < (this.#firstRank.get(f.code) ?? Number.POSITIVE_INFINITY)) this.#firstRank.set(f.code, r);
    if (r >= this.#after) return;
    this.#kept.push(f);
    if (this.#kept.length >= 2 * this.max) this.#trim();
  }

  #trim(): void {
    this.#kept.sort((a, b) => rank(a) - rank(b));
    this.#kept.length = Math.min(this.#kept.length, this.max);
    if (this.#kept.length === this.max) this.#after = rank(this.#kept[this.max - 1] as Ordered);
  }

  first(): Ordered[] {
    this.#trim();
    return this.#kept;
  }

  /** The counts, each code in the order its first finding sorts (as the findings list them). */
  tally(): CheckOutcome['counts'] {
    const codes = [...this.#firstRank].sort((a, b) => a[1] - b[1]).map(([code]) => code);
    return { ...this.counts, byCode: Object.fromEntries(codes.map((code) => [code, this.counts.byCode[code] ?? 0])) };
  }
}

/** At most this many row locations per finding (SPEC.md §4.8). */
const MAX_REFS = 20;

/** At most this many currencies in an UNBALANCED finding's nets (SPEC.md §4.5). */
const MAX_NETS = 20;

/** The longest message a finding has (SPEC.md §4.5). */
const MAX_MESSAGE = 120;

/** The column shape (SPEC.md §4.2), checked here because the Claude API refuses a root-level oneOf. */
export function mappingMode(columns: ColumnMap): Mode {
  const has = (f: MappedField) => columns[f] !== undefined;
  if (has('amount') && !has('debit') && !has('credit')) return has('side') ? 'side' : 'signed';
  if (has('debit') && has('credit') && !has('amount') && !has('side')) return 'debit_credit';
  throw new ToolError(
    'MAPPING_INVALID',
    'columns must map transaction_id plus one of: amount (signed); amount and side; or debit and credit.',
    'Map a signed amount column, an amount column with a debit/credit side column, or separate debit and credit columns.',
  );
}

interface Leg {
  minor: bigint;
  currency: string | null;
}

interface Tx {
  id: string;
  rows: LedgerRow[];
  legs: Leg[];
  hasRowError: boolean;
}

/** The finding with its fields in SPEC.md §4.5's order, whichever rule produced it. */
function inFieldOrder({ code, severity, transaction_id, lines, pointers, more_rows, field, value, nets, message }: Finding): Finding {
  return {
    code,
    severity,
    transaction_id,
    ...(lines !== undefined && { lines }),
    ...(pointers !== undefined && { pointers }),
    ...(more_rows !== undefined && { more_rows }),
    ...(field !== undefined && { field }),
    ...(value !== undefined && { value }),
    ...(nets !== undefined && { nets }),
    message,
  };
}

/** What a finding needs to point at its rows. */
function refs(rows: readonly LedgerRow[]): Pick<Finding, 'lines' | 'pointers' | 'more_rows'> {
  const shown = rows.slice(0, MAX_REFS);
  const more = rows.length - shown.length;
  const out: Pick<Finding, 'lines' | 'pointers' | 'more_rows'> =
    shown[0]?.pointer !== undefined ? { pointers: shown.map((r) => escapeUnsafe(r.pointer ?? '')) } : { lines: shown.map((r) => r.line ?? 0) }; // a pointer holds the caller's text and the file's keys
  if (more > 0) out.more_rows = more;
  return out;
}

/** A value from the file as a result shows it: text and numbers as written, other JSON values by kind. */
function shownValue(raw: unknown): string {
  if (typeof raw === 'string') return clip(raw.trim());
  if (raw instanceof JsonNumber) return clip(raw.text);
  if (Array.isArray(raw)) return 'an array';
  if (raw !== null && typeof raw === 'object') return 'an object';
  return clip(String(raw));
}

const SIDES: Readonly<Record<string, 1n | -1n>> = { D: 1n, DR: 1n, DEBIT: 1n, C: -1n, CR: -1n, CREDIT: -1n };

/** One row's leg, or the findings that stop it being one. */
function legOf(row: LedgerRow, mode: Mode, opts: CheckOptions, hasCurrency: boolean, txId: string | null, tally: CheckOutcome['amounts']): { leg?: Leg; findings: Finding[] } {
  const findings: Finding[] = [];
  const at = refs([row]);
  const problem = (code: FindingCode, field: MappedField | 'debit/credit', message: string, raw?: unknown): void => {
    const f: Finding = { code, severity: 'error', transaction_id: txId, ...at, field, message };
    if (raw !== undefined) f.value = shownValue(raw);
    findings.push(f);
  };
  const amount = (field: MappedField): bigint | null | undefined => {
    const raw = row.values[field];
    const parsed = parseAmount(raw, opts.amountFormat, opts.decimalPlaces);
    if (parsed === null) return null;
    const written = raw instanceof JsonNumber ? raw.text : typeof raw === 'string' ? raw.trim() : '';
    // Zeros aside on both sides (SPEC.md §4.4): a placeholder 0.00 says nothing about the unit.
    if (/^-?\d+\.\d+$/.test(written)) {
      if (/[1-9]/.test(written)) tally.decimalPoint += 1;
    } else if (parsed.ok && parsed.minor !== 0n) tally.plain += 1;
    if (parsed.ok) return parsed.minor;
    problem(parsed.problem, field, `${shownValue(raw)} ${parsed.why}`, raw);
    return undefined;
  };

  let minor: bigint | undefined;
  if (mode === 'debit_credit') {
    const debit = amount('debit');
    const credit = amount('credit');
    if (debit === null && credit === null) problem('MISSING_VALUE', 'debit/credit', 'debit and credit are both empty');
    else if (debit !== undefined && credit !== undefined) minor = (debit ?? 0n) - (credit ?? 0n);
  } else {
    const value = amount('amount');
    if (value === null) problem('MISSING_VALUE', 'amount', 'no amount');
    let sign: bigint | undefined = 1n;
    if (mode === 'side') {
      const raw = row.values.side;
      const side = typeof raw === 'string' ? raw.trim().toUpperCase() : undefined;
      if (raw === undefined || raw === null || side === '') {
        problem('MISSING_VALUE', 'side', 'no side');
        sign = undefined;
      } else if (side === undefined || !Object.hasOwn(SIDES, side)) {
        problem('BAD_SIDE', 'side', `${shownValue(raw)} is not D, DR, DEBIT, C, CR or CREDIT`, raw);
        sign = undefined;
      } else {
        sign = SIDES[side];
      }
      if (typeof value === 'bigint' && value < 0n) {
        problem('NEGATIVE_WITH_SIDE', 'amount', `${shownValue(row.values.amount)} is negative, but side already gives the direction`, row.values.amount);
        sign = undefined;
      }
    }
    if (typeof value === 'bigint' && sign !== undefined) minor = value * sign;
  }

  let currency: string | null = null;
  if (hasCurrency) {
    const raw = row.values.currency;
    if (typeof raw === 'string' && raw.trim() !== '') currency = raw.trim().toUpperCase();
    else if (raw instanceof JsonNumber) {
      // An ISO 4217 numeric code, such as 826, grouped by its value: 826 and 826.0 are one currency.
      const plain = plainDecimal(raw);
      currency = plain === 'too large' || plain === 'too small' ? raw.text : plain;
    }
    else problem('MISSING_VALUE', 'currency', typeof raw === 'string' || raw === undefined || raw === null ? 'no currency' : 'the currency is not text');
  }
  if (findings.length > 0 || minor === undefined) return { findings };
  if (minor === 0n) {
    findings.push({ code: 'ZERO_LEG', severity: 'warning', transaction_id: txId, ...at, field: mode === 'debit_credit' ? 'debit/credit' : 'amount', value: '0', message: 'a leg of 0 moves nothing' });
  }
  return { leg: { minor, currency }, findings };
}

/** An id that is there but cannot be read: a symbol, so no real id (even "not text") can be mistaken for it. */
const UNREADABLE = Symbol('unreadable id');

/** Why an unreadable id cannot be read. */
function unreadableId(raw: unknown): string {
  return raw instanceof JsonNumber ? 'transaction_id is a number too large or too small to use as an id' : 'transaction_id is not text or a number';
}

/**
 * The transaction id a row is grouped by: text without spaces around it (a quoted CSV value keeps
 * them otherwise), or a JSON number's exact value as text, so 1234567890123456789 and
 * 1234567890123456790 stay two ids (a 64-bit float would merge them).
 */
function idOf(raw: unknown): string | null | typeof UNREADABLE {
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim();
  if (raw instanceof JsonNumber) {
    const plain = plainDecimal(raw);
    return plain === 'too large' || plain === 'too small' ? UNREADABLE : plain;
  }
  return raw === undefined || raw === null ? null : UNREADABLE;
}

function netsText(nets: Net[]): string {
  return nets.map((n) => `${n.currency === null ? 'legs' : `${n.currency} legs`} net to ${n.net}`).join(' and ');
}

export function checkLedger(rows: readonly LedgerRow[], mode: Mode, opts: CheckOptions, hasCurrency: boolean): CheckOutcome {
  const findings = new FirstFindings(MAX_LISTED_FINDINGS);
  const txs = new Map<string, Tx>();
  const amounts = { decimalPoint: 0, plain: 0 };

  for (const row of rows) {
    if (row.bad !== undefined) {
      findings.add({ order: row.seq, code: 'BAD_ROW', severity: 'error', transaction_id: null, ...refs([row]), message: row.bad });
      continue;
    }
    const id = idOf(row.values.transaction_id);
    if (id === null || id === UNREADABLE) {
      const message = id === null ? 'no transaction_id' : unreadableId(row.values.transaction_id);
      findings.add({ order: row.seq, code: 'MISSING_VALUE', severity: 'error', transaction_id: null, ...refs([row]), field: 'transaction_id', message });
      continue;
    }
    let tx = txs.get(id);
    if (tx === undefined) {
      tx = { id, rows: [], legs: [], hasRowError: false };
      txs.set(id, tx);
    }
    tx.rows.push(row);
    const { leg, findings: rowFindings } = legOf(row, mode, opts, hasCurrency, clip(id), amounts);
    for (const f of rowFindings) findings.add({ ...f, order: row.seq });
    if (leg === undefined) tx.hasRowError = true;
    else tx.legs.push(leg);
  }

  let notChecked = 0;
  let balanced = 0;
  for (const tx of txs.values()) {
    if (tx.hasRowError) {
      notChecked += 1;
      continue;
    }
    const order = tx.rows[0]?.seq ?? 0;
    const at = { order, transaction_id: clip(tx.id), ...refs(tx.rows) };
    const moving = tx.legs.filter((leg) => leg.minor !== 0n).length;
    if (moving < 2) {
      const message = `${moving === 0 ? 'no' : 'only 1'} non-zero leg; a transaction needs at least two`;
      findings.add({ ...at, code: 'TOO_FEW_LEGS', severity: 'error', message });
      continue;
    }
    const sums = new Map<string | null, bigint>();
    for (const leg of tx.legs) sums.set(leg.currency, (sums.get(leg.currency) ?? 0n) + leg.minor);
    const off = [...sums]
      .filter(([, sum]) => sum !== 0n)
      .sort(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : 1)); // code-unit order: the same on every machine
    if (off.length > 0) {
      // Grouping used the full currency text; the result shows it cut like any value from the file.
      const nets = off.slice(0, MAX_NETS).map(([currency, sum]) => ({ currency: currency === null ? null : clip(currency), net: sum.toString() }));
      // The message is made safe once, from the raw currencies, each cut like any value from the file.
      const raw = off.slice(0, MAX_NETS).map(([currency, sum]) => ({ currency: currency === null ? null : cut(currency), net: sum.toString() }));
      const message =
        off.length > MAX_NETS ? `${off.length} currencies do not net to 0; nets lists the first ${MAX_NETS}` : clip(`${netsText(raw)}, not 0`, MAX_MESSAGE);
      findings.add({ ...at, code: 'UNBALANCED', severity: 'error', nets, message });
    } else {
      balanced += 1;
    }
  }

  return {
    findings: findings.first().map(({ order: _order, ...f }) => inFieldOrder(f)),
    counts: findings.tally(),
    amounts,
    rowsRead: rows.length,
    transactionsFound: txs.size,
    transactionsNotChecked: notChecked,
    transactionsBalanced: balanced,
  };
}
