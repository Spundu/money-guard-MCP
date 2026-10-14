// money_check_double_entry's rules (SPEC.md §4.5): integer-pence-ledger's posting rules (at least two
// legs, no leg that moves nothing, whole minor units, legs netting to zero), applied to every
// transaction of an export, returning every problem instead of throwing at the first.

import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import { parseAmount, type AmountFormat } from '../money.js';
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
  /** Every finding, sorted by first location, then code. */
  findings: Finding[];
  rowsRead: number;
  transactionsFound: number;
  transactionsNotChecked: number;
  transactionsBalanced: number;
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
    shown[0]?.pointer !== undefined ? { pointers: shown.map((r) => r.pointer ?? '') } : { lines: shown.map((r) => r.line ?? 0) };
  if (more > 0) out.more_rows = more;
  return out;
}

function shownValue(raw: unknown): string {
  return clip(typeof raw === 'string' ? raw.trim() : String(raw));
}

const SIDES: Readonly<Record<string, 1n | -1n>> = { D: 1n, DR: 1n, DEBIT: 1n, C: -1n, CR: -1n, CREDIT: -1n };

/** One row's leg, or the findings that stop it being one. */
function legOf(row: LedgerRow, mode: Mode, opts: CheckOptions, hasCurrency: boolean, txId: string | null): { leg?: Leg; findings: Finding[] } {
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
        problem('NEGATIVE_WITH_SIDE', 'amount', `${value} is negative, but side already gives the direction`, row.values.amount);
        sign = undefined;
      }
    }
    if (typeof value === 'bigint' && sign !== undefined) minor = value * sign;
  }

  let currency: string | null = null;
  if (hasCurrency) {
    const raw = row.values.currency;
    if (typeof raw === 'string' && raw.trim() !== '') currency = raw.trim().toUpperCase();
    else problem('MISSING_VALUE', 'currency', typeof raw === 'string' || raw === undefined || raw === null ? 'no currency' : 'the currency is not text');
  }
  if (findings.length > 0 || minor === undefined) return { findings };
  if (minor === 0n) {
    findings.push({ code: 'ZERO_LEG', severity: 'warning', transaction_id: txId, ...at, field: mode === 'debit_credit' ? 'debit/credit' : 'amount', value: '0', message: 'a leg of 0 moves nothing' });
  }
  return { leg: { minor, currency }, findings };
}

function idOf(raw: unknown): string | null | 'not text' {
  if (typeof raw === 'string') return raw === '' ? null : raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return raw === undefined || raw === null ? null : 'not text';
}

function netsText(nets: Net[]): string {
  return nets.map((n) => `${n.currency === null ? 'legs' : `${n.currency} legs`} net to ${n.net}`).join(' and ');
}

export function checkLedger(rows: readonly LedgerRow[], mode: Mode, opts: CheckOptions, hasCurrency: boolean): CheckOutcome {
  const findings: Array<Finding & { order: number }> = [];
  const txs = new Map<string, Tx>();

  for (const row of rows) {
    if (row.bad !== undefined) {
      findings.push({ order: row.seq, code: 'BAD_ROW', severity: 'error', transaction_id: null, ...refs([row]), message: row.bad });
      continue;
    }
    const id = idOf(row.values.transaction_id);
    if (id === null || id === 'not text') {
      const message = id === null ? 'no transaction_id' : 'transaction_id is not text or a number';
      findings.push({ order: row.seq, code: 'MISSING_VALUE', severity: 'error', transaction_id: null, ...refs([row]), field: 'transaction_id', message });
      continue;
    }
    let tx = txs.get(id);
    if (tx === undefined) {
      tx = { id, rows: [], legs: [], hasRowError: false };
      txs.set(id, tx);
    }
    tx.rows.push(row);
    const { leg, findings: rowFindings } = legOf(row, mode, opts, hasCurrency, clip(id));
    for (const f of rowFindings) findings.push({ ...f, order: row.seq });
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
      findings.push({ ...at, code: 'TOO_FEW_LEGS', severity: 'error', message });
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
      const message =
        off.length > MAX_NETS ? `${off.length} currencies do not net to 0; nets lists the first ${MAX_NETS}` : clip(`${netsText(nets)}, not 0`, MAX_MESSAGE);
      findings.push({ ...at, code: 'UNBALANCED', severity: 'error', nets, message });
    } else {
      balanced += 1;
    }
  }

  findings.sort((a, b) => a.order - b.order || CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code));
  return {
    findings: findings.map(({ order: _order, ...f }) => inFieldOrder(f)),
    rowsRead: rows.length,
    transactionsFound: txs.size,
    transactionsNotChecked: notChecked,
    transactionsBalanced: balanced,
  };
}
