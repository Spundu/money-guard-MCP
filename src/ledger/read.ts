// Reading a ledger export (SPEC.md §4.3) into rows holding just the mapped values and where each row
// is. File-level problems are ToolErrors; a bad record in JSON or JSONL becomes a row marked `bad`, so
// the check carries on and reports it with the rest.

import { CsvError, parse } from 'csv-parse/sync';
import { closest } from '../closest.js';
import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import { JsonLimitError, JsonNumber, JsonSyntaxError, parseLedgerJson } from './json.js';

export type LedgerFormat = 'csv' | 'json' | 'jsonl';

/** Which column (CSV) or field (JSON) holds what. SPEC.md §4.2. */
export interface ColumnMap {
  transaction_id: string;
  amount?: string | undefined;
  side?: string | undefined;
  debit?: string | undefined;
  credit?: string | undefined;
  currency?: string | undefined;
}

export type MappedField = keyof ColumnMap;

export interface LedgerRow {
  /** Position among the records (0-based): the order findings are sorted in. */
  seq: number;
  /** CSV and JSONL: the 1-based line the record starts on. */
  line?: number;
  /** JSON: the record's JSON Pointer. */
  pointer?: string;
  /** The mapped values as read: trimmed strings (CSV) or JSON values. Absent field: undefined. */
  values: Partial<Record<MappedField, unknown>>;
  /** Why the record could not be read (JSON and JSONL only). */
  bad?: string;
}

/** At most this many data rows (SPEC.md §4.8). */
export const MAX_ROWS = 1_000_000;
/** JSON nesting limit (SPEC.md §4.8). */
const MAX_DEPTH = 100;

/**
 * Most JSON objects and arrays one file may hold. A million records with one nested object each fit; a
 * file of bare nested arrays, at about 180 bytes of memory each, stops near 450 MB instead of 2 GiB.
 */
export const MAX_CONTAINERS = 2_500_000;

function tooManyContainers(): ToolError {
  return new ToolError(
    'FILE_TOO_LARGE',
    `The file holds more than ${MAX_CONTAINERS.toLocaleString('en-GB')} JSON objects and arrays; this tool reads at most that many.`,
    'Export a smaller file (a date range, say) and check the parts one by one.',
  );
}

const MAPPED_FIELDS: readonly MappedField[] = ['transaction_id', 'amount', 'side', 'debit', 'credit', 'currency'];

function mappedEntries(columns: ColumnMap): Array<[MappedField, string]> {
  return MAPPED_FIELDS.flatMap((field) => {
    const name = columns[field];
    return name === undefined ? [] : [[field, name] as [MappedField, string]];
  });
}

/** Line and column (1-based) of character index `index` in `text`. */
export function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line += 1;
    start = i + 1;
  }
  return { line, column: index - start + 1 };
}

function tooManyRows(): ToolError {
  return new ToolError('TOO_MANY_ROWS', `The file has more than ${MAX_ROWS.toLocaleString('en-GB')} rows.`, 'Export a smaller range (a month, say) and check the parts one by one.');
}

// ---------------------------------------------------------------------------------------------- CSV

function findColumn(header: string[], field: MappedField, name: string): number {
  const exact = header.flatMap((h, i) => (h === name ? [i] : []));
  const matches = exact.length > 0 ? exact : header.flatMap((h, i) => (h.toLowerCase() === name.toLowerCase() ? [i] : []));
  if (matches.length === 1) return matches[0] ?? -1;
  if (matches.length > 1) {
    throw new ToolError('COLUMN_AMBIGUOUS', `The header has ${matches.length} columns named "${clip(name)}" (mapped as ${field}).`, 'Rename one of them in the export, or map a different column.');
  }
  const shown = header.slice(0, 30).map((h) => `"${clip(h)}"`);
  const more = header.length > 30 ? ` and ${header.length - 30} more` : '';
  const near = closest(name, header);
  const hint = near === undefined ? '' : ` Did you mean "${clip(near)}"?`;
  throw new ToolError(
    'COLUMN_NOT_FOUND',
    `The CSV header has no column "${clip(name)}" (mapped as ${field}).${hint} The columns are: ${shown.join(', ')}${more}.`,
    'Map each field to one of the column names in the header.',
  );
}

const CSV_PROBLEMS: Readonly<Record<string, string>> = {
  CSV_QUOTE_NOT_CLOSED: 'a quoted field is never closed',
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: 'the row does not have as many fields as the header',
  CSV_INVALID_CLOSING_QUOTE: 'a quote closes in the middle of a field',
  CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: 'text follows a closing quote',
  INVALID_OPENING_QUOTE: 'a quote opens in the middle of a field',
};

/**
 * The 1-based line each record starts on. csv-parse's own line count is wrong for a quoted field that
 * holds a CRLF line break (it counts the CR as a line too), but its byte offsets are exact, so lines
 * are counted here: line feeds before the record's first character, blank lines skipped.
 */
function startLines(bytes: Uint8Array, ends: readonly number[]): number[] {
  // A line ends at LF, or at a CR that no LF follows (CR-only files, as old Mac Excel writes them).
  const endsLine = (i: number) => bytes[i] === 0x0a || (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a);
  const lines: number[] = [];
  let pos = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = pos; i < to; i += 1) if (endsLine(i)) line += 1;
    pos = to;
  };
  for (const end of ends) {
    // The record starts on the first line with something other than spaces and tabs.
    let start = pos;
    for (let j = pos; j < end; j += 1) {
      if (endsLine(j)) start = j + 1;
      else if (bytes[j] !== 0x20 && bytes[j] !== 0x09 && bytes[j] !== 0x0d) break;
    }
    advance(start);
    lines.push(line);
    advance(end);
  }
  return lines;
}

function readCsv(bytes: Uint8Array, columns: ColumnMap, delimiter: string): Ledger {
  // Where each record ends (a byte offset), collected as records are read: a broken record starts
  // right after the last good one, which gives its line even though the parse failed.
  const ends: number[] = [];
  let records: string[][];
  try {
    records = parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      bom: true,
      delimiter,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      to: MAX_ROWS + 2, // the header, the limit, and one more to detect "too many"
      on_record: (record: string[], context: { bytes: number }) => {
        ends.push(context.bytes);
        return record;
      },
    }) as string[][];
  } catch (err) {
    if (!(err instanceof CsvError)) throw err;
    const line = startLines(bytes, [...ends, bytes.length]).at(-1) ?? 1;
    const problem = CSV_PROBLEMS[err.code] ?? 'the CSV structure is broken';
    throw new ToolError('PARSE_ERROR', `Line ${line}: ${problem}.`, 'Fix the CSV at that line (quotes must be doubled inside quoted fields), or pass the right delimiter.');
  }
  const [header, ...data] = records;
  if (header === undefined) return { rows: [], names: [] };
  if (data.length > MAX_ROWS) throw tooManyRows();
  const indexes = mappedEntries(columns).map(([field, name]) => [field, findColumn(header, field, name)] as const);
  const lines = startLines(bytes, ends);
  const rows = data.map((record, seq) => {
    const values: Partial<Record<MappedField, unknown>> = {};
    for (const [field, index] of indexes) values[field] = record[index];
    return { seq, line: lines[seq + 1] ?? 0, values };
  });
  return { rows, names: header };
}

// --------------------------------------------------------------------------------------------- JSON

/** The value at RFC 6901 pointer `pointer` inside `doc`, or undefined. Own properties only. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let node: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      node = node[Number(token)];
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      node = (node as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber);
}

function valuesOf(record: Record<string, unknown>, columns: ColumnMap): Partial<Record<MappedField, unknown>> {
  const values: Partial<Record<MappedField, unknown>> = {};
  for (const [field, name] of mappedEntries(columns)) {
    values[field] = name.startsWith('/') ? resolvePointer(record, name) : Object.hasOwn(record, name) ? record[name] : undefined;
  }
  return values;
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing (the pointer leads nowhere)';
  if (value === null) return 'null';
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 20).map((k) => clip(k)).join(', ');
    return keys.length === 0 ? 'an empty object' : `an object with keys ${shown}${keys.length > 20 ? ', …' : ''}`;
  }
  return value instanceof JsonNumber ? 'a number' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/**
 * JSON and JSONL: a mapped field that no record has is a wrong mapping, not a problem in every row.
 * Report it once, with the first record's fields, as a missing CSV column is reported.
 */
function requireMappedFields(rows: readonly LedgerRow[], columns: ColumnMap, first: Record<string, unknown> | undefined): void {
  if (first === undefined) return; // no record is an object: each row says so already
  const good = rows.filter((row) => row.bad === undefined);
  for (const [field, name] of mappedEntries(columns)) {
    if (good.some((row) => row.values[field] !== undefined)) continue;
    const keys = Object.keys(first);
    const near = name.startsWith('/') ? undefined : closest(name, keys);
    const hint = near === undefined ? '' : ` Did you mean "${clip(near)}"?`;
    const shown = keys.slice(0, 30).map((k) => `"${clip(k)}"`).join(', ');
    const fields = keys.length === 0 ? 'The first record has no fields.' : `The first record's fields are: ${shown}${keys.length > 30 ? ` and ${keys.length - 30} more` : ''}.`;
    throw new ToolError(
      'COLUMN_NOT_FOUND',
      `No record has the field "${clip(name)}" (mapped as ${field}).${hint} ${fields}`,
      'Map each field to a field the records have, or to a JSON Pointer such as "/amount/value" for a nested one.',
    );
  }
}

function parseOrThrow(text: string): unknown {
  try {
    return parseLedgerJson(text, MAX_DEPTH, { containers: MAX_CONTAINERS });
  } catch (err) {
    if (err instanceof JsonLimitError) throw tooManyContainers();
    if (!(err instanceof JsonSyntaxError)) throw err;
    const at = /at position (\d+)$/.exec(err.message);
    const where = at?.[1] === undefined ? '' : (({ line, column }) => `Line ${line}, column ${column}: `)(lineColumn(text, Number(at[1])));
    throw new ToolError('PARSE_ERROR', `${where}the file is not valid JSON (${clip(err.message.replace(/ at position \d+$/, ''), 60)}).`, 'Fix the JSON, or pass format "jsonl" if the file holds one JSON object per line.');
  }
}

function readJson(text: string, columns: ColumnMap, recordsPointer: string): Ledger {
  const records = resolvePointer(parseOrThrow(text), recordsPointer);
  if (!Array.isArray(records)) {
    const where = recordsPointer === '' ? 'The top of the file' : `The value at "${clip(recordsPointer, 80)}"`;
    throw new ToolError('RECORDS_NOT_ARRAY', `${where} is ${describe(records)}, not an array of records.`, 'Pass records_pointer: the JSON Pointer of the array of ledger rows, such as "/data/entries".');
  }
  if (records.length > MAX_ROWS) throw tooManyRows();
  const rows = records.map((record: unknown, seq): LedgerRow => {
    const pointer = `${recordsPointer}/${seq}`;
    return isRecord(record) ? { seq, pointer, values: valuesOf(record, columns) } : { seq, pointer, values: {}, bad: 'the record is not a JSON object' };
  });
  const first = records.find(isRecord);
  requireMappedFields(rows, columns, first);
  return { rows, names: first === undefined ? [] : Object.keys(first) };
}

function readJsonl(text: string, columns: ColumnMap): Ledger {
  const rows: LedgerRow[] = [];
  let first: Record<string, unknown> | undefined;
  const lines = text.split('\n');
  const budget = { containers: MAX_CONTAINERS }; // for the whole file, not each line
  for (const [i, raw] of lines.entries()) {
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (content.trim() === '') continue;
    if (rows.length === MAX_ROWS) throw tooManyRows();
    const base = { seq: rows.length, line: i + 1 };
    let value: unknown;
    try {
      value = parseLedgerJson(content, MAX_DEPTH, budget);
    } catch (err) {
      if (err instanceof JsonLimitError) throw tooManyContainers();
      if (!(err instanceof JsonSyntaxError)) throw err;
      rows.push({ ...base, values: {}, bad: 'the line is not valid JSON' });
      continue;
    }
    if (isRecord(value)) first ??= value;
    rows.push(isRecord(value) ? { ...base, values: valuesOf(value, columns) } : { ...base, values: {}, bad: 'the line is not a JSON object' });
  }
  requireMappedFields(rows, columns, first);
  return { rows, names: first === undefined ? [] : Object.keys(first) };
}

/** The rows of a ledger export, and the column or field names it has (the CSV header, or the first record's fields). */
export interface Ledger {
  rows: LedgerRow[];
  names: string[];
}

/**
 * Read the rows of a ledger export. `bytes` is the file and `text` its UTF-8 decoding (already checked):
 * CSV is parsed from the bytes, whose offsets give exact line numbers; JSON and JSONL from the text.
 */
export function readLedger(
  bytes: Uint8Array,
  text: string,
  options: { format: LedgerFormat; columns: ColumnMap; delimiter: string; recordsPointer: string },
): Ledger {
  switch (options.format) {
    case 'csv':
      return readCsv(bytes, options.columns, options.delimiter);
    case 'json':
      return readJson(text, options.columns, options.recordsPointer);
    case 'jsonl':
      return readJsonl(text, options.columns);
  }
}
