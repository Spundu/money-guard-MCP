// money_check_double_entry from arguments to result (SPEC.md §4): check the path, read the file,
// apply the rules, then cut the page the caller asked for. Throws a ToolError for anything the model
// must fix before the file can be checked at all.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { overBudget } from '../budget.js';
import { clipPath, quoted } from '../echo.js';
import { ToolError } from '../errors.js';
import type { AmountFormat } from '../money.js';
import { readChecked, resolveInRoot, splitCamel, type Root } from '../paths.js';
import { MAX_LISTED_FINDINGS, checkLedger, mappingMode, type Finding, type FindingCode } from './check.js';
import { looksLikeValue, readLedger, type ColumnMap, type LedgerFormat } from './read.js';

export const LEDGER_EXTENSIONS: readonly string[] = ['.csv', '.tsv', '.json', '.jsonl', '.ndjson'];
export const LEDGER_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export interface LedgerParams {
  file: string;
  columns: ColumnMap;
  amount_format?: AmountFormat | undefined;
  decimal_places?: number | undefined;
  format?: LedgerFormat | undefined;
  delimiter?: string | undefined;
  records_pointer?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface LedgerResult {
  summary: string;
  file: string;
  format: LedgerFormat;
  file_sha256: string;
  rows_read: number;
  transactions_found: number;
  transactions_checked: number;
  transactions_balanced: number;
  transactions_not_checked: number;
  balanced: boolean;
  error_count: number;
  warning_count: number;
  counts_by_code: Partial<Record<FindingCode, number>>;
  findings: Finding[];
  offset: number;
  limit: number;
  total_findings: number;
  next_offset: number | null;
}

const BY_EXTENSION: Readonly<Record<string, LedgerFormat>> = { '.csv': 'csv', '.tsv': 'csv', '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl' };

/** A count as every summary writes it: 10,005, not 10005. */
function num(n: number): string {
  return n.toLocaleString('en-GB');
}

function count(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    // Fatal: a byte that is not UTF-8 is an error, not a silent U+FFFD. A leading BOM is dropped.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError('PARSE_ERROR', 'The file is not valid UTF-8 text.', 'Export the file as UTF-8 (most tools offer "CSV UTF-8").');
  }
}

export function checkLedgerFile(root: Root, params: LedgerParams): LedgerResult {
  const target = resolveInRoot(root, params.file, { kind: 'file', extensions: LEDGER_EXTENSIONS, maxBytes: LEDGER_MAX_BYTES });
  const mode = mappingMode(params.columns);
  const extension = path.extname(target.rel).toLowerCase();
  const format = params.format ?? BY_EXTENSION[extension] ?? 'csv';
  const delimiter = params.delimiter ?? (extension === '.tsv' ? '\t' : ',');

  const bytes = readChecked(target.real, target.rel);
  const { rows, names } = readLedger(bytes, decodeUtf8(bytes), { format, columns: params.columns, delimiter, recordsPointer: params.records_pointer ?? '' });
  const outcome = checkLedger(
    rows,
    mode,
    { amountFormat: params.amount_format ?? 'minor_units', decimalPlaces: params.decimal_places ?? 2 },
    params.columns.currency !== undefined,
  );

  const all = outcome.findings; // the first MAX_LISTED_FINDINGS; the counts cover every finding
  const { errors, warnings, byCode: countsByCode, total, withoutTransaction } = outcome.counts;

  const offset = params.offset ?? 0;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const page = all.slice(offset, offset + limit);
  const checked = outcome.transactionsFound - outcome.transactionsNotChecked;

  const result: LedgerResult = {
    summary: summarise(outcome.rowsRead, errors, warnings, outcome.transactionsFound, outcome.transactionsBalanced, outcome.transactionsNotChecked, countsByCode, withoutTransaction) + poundsHint(params.amount_format ?? 'minor_units', outcome.amounts) + currencyHint(params.columns, names) + headerHint(format, params.columns) + (total > MAX_LISTED_FINDINGS ? ` Only the first ${num(MAX_LISTED_FINDINGS)} findings can be paged; the counts cover all ${num(total)}.` : '')
      + (offset > 0 && page.length === 0 && total > 0 ? ` No findings from offset ${num(offset)}: there ${total === 1 ? 'is' : 'are'} ${num(Math.min(total, MAX_LISTED_FINDINGS))} to page.` : ''), // as the lint says (round 15)
    file: clipPath(target.rel),
    format,
    file_sha256: createHash('sha256').update(bytes).digest('hex'),
    rows_read: outcome.rowsRead,
    transactions_found: outcome.transactionsFound,
    transactions_checked: checked,
    transactions_balanced: outcome.transactionsBalanced,
    transactions_not_checked: outcome.transactionsNotChecked,
    balanced: outcome.rowsRead > 0 && errors === 0,
    error_count: errors,
    warning_count: warnings,
    counts_by_code: countsByCode,
    findings: page,
    offset,
    limit,
    total_findings: total,
    next_offset: null,
  };
  const settle = () => {
    result.next_offset = offset + page.length < all.length ? offset + page.length : null;
  };
  settle();
  // Over the budget (long locations): a shorter page, never empty, and next_offset carries on from
  // where it stopped, so paging still reaches every finding.
  while (page.length > 1 && overBudget(result)) {
    page.pop();
    settle();
  }
  // One finding can be too long on its own: 20 locations, each repeating a records_pointer of 256
  // characters whose backslashes a result shows doubled (review round 12: 25,000 characters, and the
  // call failed). Show fewer of its locations, counting the rest in more_rows, as for rows past 20.
  const only = page[0];
  const shown = only?.pointers ?? only?.lines ?? [];
  for (let keep = shown.length - 1; only !== undefined && keep >= 1 && overBudget(result); keep -= 1) page[0] = fewerLocations(only, keep);
  return result;
}

/** The finding with only its first `keep` locations, the rest counted in more_rows, in the fields' order. */
function fewerLocations(finding: Finding, keep: number): Finding {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(finding)) {
    if (key === 'more_rows') continue;
    if ((key === 'pointers' || key === 'lines') && Array.isArray(value)) {
      out[key] = value.slice(0, keep);
      out.more_rows = (finding.more_rows ?? 0) + value.length - keep;
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Finding;
}

/** When at least as many amounts have a decimal point as not (zeros aside), the file most likely holds pounds read as pence: say how to read it. */
function poundsHint(format: AmountFormat, amounts: { decimalPoint: number; plain: number }): string {
  return format === 'minor_units' && amounts.decimalPoint > 0 && amounts.decimalPoint >= amounts.plain
    ? ' Half or more of the non-zero amounts have a decimal point: if the file holds pounds or dollars (12.34), call again with amount_format "decimal".'
    : '';
}

/** A mapped CSV column named like a value: the file may have no header line, so its first row was read as one (review round 20). */
function headerHint(format: string, columns: ColumnMap): string {
  if (format !== 'csv') return '';
  const value = Object.values(columns).find((n) => typeof n === 'string' && looksLikeValue(n));
  return value === undefined ? '' : ` The mapped column ${quoted(value)} is named like a value: if the file has no header line, its first row was read as the column names, and was not checked.`;
}

/** A column that looks like a currency but is not mapped: every row then counts as one currency. */
function currencyHint(columns: ColumnMap, names: readonly string[]): string {
  if (columns.currency !== undefined) return '';
  // "Currency", "Gross Currency", "Currency ISO Code", "Currency (ISO)", "iso_currency_code",
  // "baseCurrency", "txn_ccy", "curr", "/amount/currency": a currency word anywhere ("cur" only first,
  // as "balance_cur" may be current). Not a name that also holds an amount word ("amount_currency", an
  // amount in another currency; "Cur Balance"; "debit_in_account_currency") or a period ("cur_period"),
  // nor one that ends in a rate or a ratio. A plain currency name ("Currency", "ccy", "Currency Code")
  // is preferred to one that says which currency it is ("Original Currency"), and a name that ends in
  // its currency word or in "code" to the others.
  const AMOUNT_WORDS = ['amount', 'amounts', 'balance', 'balances', 'bal', 'bals', 'debit', 'credit', 'total', 'price', 'fee', 'value', 'values', 'period', 'rate', 'rates', 'factor', 'ratio', 'in'];
  // For a JSON Pointer, the field's own name: "/amount/currency" is a currency beside an amount.
  const wordsOf = (name: string) =>
    splitCamel(name.startsWith('/') ? name.slice(name.lastIndexOf('/') + 1) : name, ' ') // "ISOCurrencyCode" too (round 16)
      .toLowerCase()
      .replace(/(\p{L})(?=\p{N})/gu, '$1 ') // "ISO4217" too (round 17)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== '');
  // hledger, beancount: commodity; German, French, Spanish (two words), Italian and Dutch; ISO 4217 (review rounds 15, 17)
  // Round 21: "Waehrung" written in ASCII.
  const CURRENCY = ['currency', 'currencies', 'ccy', 'curr', 'commodity', 'commodities', 'währung', 'waehrung', 'wahrung', 'devise', 'moneda', 'divisa', 'valuta', '4217'];
  // A crypto exchange's asset or coin (Kraken), alone or with code or symbol, not "asset_id"; "ISO Code" (round 21).
  const coin = (ws: readonly string[]) => ['asset', 'coin'].includes(ws[0] ?? '') && (ws.length === 1 || (ws.length === 2 && ['code', 'symbol'].includes(ws[1] ?? '')));
  const isoCode = (ws: readonly string[]) => ws.length === 2 && ws[0] === 'iso' && ws[1] === 'code';
  // "curr" before a date or a period is "current" (review round 17: curr_month, Curr Date).
  const PERIOD_WORDS = ['date', 'day', 'week', 'month', 'quarter', 'year', 'period', 'time'];
  // "Valuta" is also the value date (German banks; Italian "Data valuta"): beside a date word it is that (round 19).
  const DATE_WORDS = ['date', 'data', 'datum', 'dt', 'tag', 'giorno', 'wertstellung']; // Comdirect: "Wertstellung (Valuta)" (round 21)
  const looksLikeCurrency = (name: string) => {
    const ws = wordsOf(name);
    // A flag (is_foreign_currency) or a pair (ccy_pair, GBPUSD) is not the currency of a row (review round 12).
    if (['is', 'has'].includes(ws[0] ?? '') || ws.includes('pair') || ws.includes('pairs')) return false;
    const dated = ws.some((x) => DATE_WORDS.includes(x)); // once per name: per word it was quadratic (review round 20)
    const currency = ws.some((w, i) => CURRENCY.includes(w) && !(w === 'curr' && PERIOD_WORDS.includes(ws[i + 1] ?? '')) && !(w === 'valuta' && dated)) || (ws[0] === 'cur' && (ws.length === 1 || ws[1] === 'code')) || coin(ws) || isoCode(ws);
    return currency && !ws.some((w) => AMOUNT_WORDS.includes(w));
  };
  const endsLikeOne = (name: string) => [...CURRENCY, 'cur', 'code'].includes(wordsOf(name).at(-1) ?? '');
  const plain = (name: string) => {
    const ws = wordsOf(name);
    return CURRENCY.includes(ws[0] ?? '') && (ws.length === 1 || (ws.length === 2 && ws[1] === 'code'));
  };
  // "Valuta" alone may still be the value date: a name with another currency word comes first (ING: "Valuta", "Währung").
  // Each group is ranked on its own (review round 20: a plain "Valuta" was named before "Transaction Currency").
  const found = names.filter(looksLikeCurrency);
  const valuta = (n: string) => wordsOf(n).includes('valuta');
  const best = (group: readonly string[]) => group.find(plain) ?? group.find(endsLikeOne) ?? group[0];
  const name = best(found.filter((n) => !valuta(n))) ?? best(found.filter(valuta));
  return name === undefined ? '' : ` ${quoted(name)} looks like a currency and is not mapped: map it as currency to check each currency on its own (now every row counts as one).`;
}

function summarise(
  rows: number,
  errors: number,
  warnings: number,
  found: number,
  balanced: number,
  notChecked: number,
  counts: Partial<Record<FindingCode, number>>,
  loose: number,
): string {
  if (rows === 0) return 'The file has no rows, so nothing was proven.';
  const warned = warnings > 0 ? ` ${count(warnings, 'warning', 'warnings')}.` : '';
  if (errors === 0) {
    const all = found === 1 ? 'the 1 transaction nets' : `all ${num(found)} transactions net`;
    return `Balanced: ${all} to zero in whole minor units.${warned}`;
  }
  const parts = [`${num(balanced)} balanced`];
  if (counts.UNBALANCED) parts.push(`${num(counts.UNBALANCED)} unbalanced`);
  if (counts.TOO_FEW_LEGS) parts.push(`${num(counts.TOO_FEW_LEGS)} with too few legs`);
  if (notChecked > 0) parts.push(`${num(notChecked)} not checked (rows with unreadable values)`);
  const head = `Not balanced: ${count(errors, 'error', 'errors')}${warnings > 0 ? ` and ${count(warnings, 'warning', 'warnings')}` : ''}.`;
  // Errors that belong to no transaction (a record that is not an object, a row without an id) are
  // counted apart, or the transaction counts alone would not explain them.
  const outside = loose > 0 ? ` ${count(loose, 'row is', 'rows are')} outside any transaction (no readable id, or not a record).` : '';
  return `${head} ${count(found, 'transaction', 'transactions')}: ${parts.join(', ')}.${outside}`;
}
