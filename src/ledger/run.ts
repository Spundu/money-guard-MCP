// money_check_double_entry from arguments to result (SPEC.md §4): check the path, read the file,
// apply the rules, then cut the page the caller asked for. Throws a ToolError for anything the model
// must fix before the file can be checked at all.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { overBudget } from '../budget.js';
import { escapeUnsafe } from '../echo.js';
import { ToolError } from '../errors.js';
import type { AmountFormat } from '../money.js';
import { resolveInRoot, type Root } from '../paths.js';
import { checkLedger, mappingMode, type Finding, type FindingCode } from './check.js';
import { readLedger, type ColumnMap, type LedgerFormat } from './read.js';

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

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
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

  const bytes = readFileSync(target.real);
  const rows = readLedger(bytes, decodeUtf8(bytes), { format, columns: params.columns, delimiter, recordsPointer: params.records_pointer ?? '' });
  const outcome = checkLedger(
    rows,
    mode,
    { amountFormat: params.amount_format ?? 'minor_units', decimalPlaces: params.decimal_places ?? 2 },
    params.columns.currency !== undefined,
  );

  const all = outcome.findings;
  const errors = all.filter((f) => f.severity === 'error').length;
  const warnings = all.length - errors;
  const countsByCode: Partial<Record<FindingCode, number>> = {};
  for (const f of all) countsByCode[f.code] = (countsByCode[f.code] ?? 0) + 1;

  const offset = params.offset ?? 0;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const page = all.slice(offset, offset + limit);
  const checked = outcome.transactionsFound - outcome.transactionsNotChecked;

  const result: LedgerResult = {
    summary: summarise(outcome.rowsRead, errors, warnings, outcome.transactionsFound, outcome.transactionsBalanced, outcome.transactionsNotChecked, countsByCode),
    file: escapeUnsafe(target.rel),
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
    total_findings: all.length,
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
  return result;
}

function summarise(
  rows: number,
  errors: number,
  warnings: number,
  found: number,
  balanced: number,
  notChecked: number,
  counts: Partial<Record<FindingCode, number>>,
): string {
  if (rows === 0) return 'The file has no rows, so nothing was proven.';
  const warned = warnings > 0 ? ` ${count(warnings, 'warning', 'warnings')}.` : '';
  if (errors === 0) {
    const all = found === 1 ? 'the 1 transaction nets' : `all ${found} transactions net`;
    return `Balanced: ${all} to zero in whole minor units.${warned}`;
  }
  const parts = [`${balanced} balanced`];
  if (counts.UNBALANCED) parts.push(`${counts.UNBALANCED} unbalanced`);
  if (counts.TOO_FEW_LEGS) parts.push(`${counts.TOO_FEW_LEGS} with too few legs`);
  if (notChecked > 0) parts.push(`${notChecked} not checked (rows with unreadable values)`);
  const head = `Not balanced: ${count(errors, 'error', 'errors')}${warnings > 0 ? ` and ${count(warnings, 'warning', 'warnings')}` : ''}.`;
  return `${head} ${count(found, 'transaction', 'transactions')}: ${parts.join(', ')}.`;
}
