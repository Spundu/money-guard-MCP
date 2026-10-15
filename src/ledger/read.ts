// Reading a ledger export (SPEC.md §4.3) into rows holding just the mapped values and where each row
// is. File-level problems are ToolErrors; a bad record in JSON or JSONL becomes a row marked `bad`, so
// the check carries on and reports it with the rest.

import { CsvError, parse } from 'csv-parse/sync';
import { closest } from '../closest.js';
import { clip, NAME_MAX, quoted } from '../echo.js';
import { ToolError } from '../errors.js';
import { JsonLimitError, JsonNumber, JsonSyntaxError, MAX_FIELD_NAMES, MAX_OBJECT_KEYS, parseLedgerJson, type JsonBudget } from './json.js';

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

/**
 * Most JSON values of any kind one file may hold. A record costs at least 5 characters a field
 * ("a":1,), so a 25 MiB file of records holds about 5 million at most; an array of bare numbers (2
 * characters each) could hold 13 million, at about 60 bytes of memory each.
 */
export const MAX_VALUES = 7_000_000;

function jsonBudget(): JsonBudget {
  return { containers: MAX_CONTAINERS, values: MAX_VALUES, names: new Set() };
}

function tooLarge(err: JsonLimitError): ToolError {
  const what =
    err.kind === 'keys'
      ? `an object with more than ${MAX_OBJECT_KEYS.toLocaleString('en-GB')} keys`
      : err.kind === 'names'
        ? `more than ${MAX_FIELD_NAMES.toLocaleString('en-GB')} different field names`
      : err.kind === 'values'
        ? `more than ${MAX_VALUES.toLocaleString('en-GB')} JSON values`
        : `more than ${MAX_CONTAINERS.toLocaleString('en-GB')} JSON objects and arrays`;
  return new ToolError('FILE_TOO_LARGE', `The file holds ${what}; this tool reads at most that many.`, 'Export a smaller file (a date range, say) and check the parts one by one.');
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

/** The delimiters the delimiter parameter takes (SPEC.md §4.2). */
const DELIMITERS: readonly string[] = [',', ';', '\t', '|'];

/** A delimiter as a fix shows it: in JSON, as the parameter takes it, with tabs named. */
function showDelimiter(d: string): string {
  return d === '\t' ? '"\\t" (tabs)' : JSON.stringify(d);
}

function findColumn(header: string[], field: MappedField, name: string, delimiter: string): number {
  const exact = header.flatMap((h, i) => (h === name ? [i] : []));
  const matches = exact.length > 0 ? exact : header.flatMap((h, i) => (h.toLowerCase() === name.toLowerCase() ? [i] : []));
  if (matches.length === 1) return matches[0] ?? -1;
  if (matches.length > 1) {
    throw new ToolError('COLUMN_AMBIGUOUS', `The header has ${matches.length} columns named ${quoted(name)} (mapped as ${field}).`, 'Rename one of them in the export, or map a different column.');
  }
  const shown = header.slice(0, 30).map((h) => `${quoted(h)}`);
  const more = header.length > 30 ? ` and ${header.length - 30} more` : '';
  const near = closest(name, header);
  const hint = near === undefined ? '' : ` Did you mean ${quoted(near, NAME_MAX)}?`;
  // A header read as one column that holds another delimiter: the file is separated by that one.
  // The one that occurs most in the header, read as one column, is the likeliest delimiter.
  const count = (d: string) => (header[0] ?? '').split(d).length - 1;
  const other = header.length === 1 ? DELIMITERS.filter((d) => d !== delimiter && count(d) > 0).sort((x, y) => count(y) - count(x))[0] : undefined;
  throw new ToolError(
    'COLUMN_NOT_FOUND',
    `The CSV header has no column ${quoted(name)} (mapped as ${field}).${hint} The columns are: ${shown.join(', ')}${more}.`,
    other === undefined
      ? 'Map each field to one of the column names in the header.'
      : `The file looks separated by ${showDelimiter(other)}, not ${showDelimiter(delimiter)}: pass delimiter ${JSON.stringify(other)}.`,
  );
}

const CSV_PROBLEMS: Readonly<Record<string, string>> = {
  CSV_QUOTE_NOT_CLOSED: 'a quoted field is never closed',
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: 'the row does not have as many fields as the header',
  CSV_INVALID_CLOSING_QUOTE: 'a quote closes in the middle of a field',
  CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: 'text follows a closing quote',
  INVALID_OPENING_QUOTE: 'a quote opens in the middle of a field',
  CSV_MAX_RECORD_SIZE: 'a row holds more than 1 MiB of values',
};

/**
 * The most characters of values one CSV row may hold (delimiters aside). A ledger row holds a few hundred;
 * a row of 25 MiB (13 million one-character fields) took 15 seconds to read on a busy machine.
 */
const MAX_ROW_CHARS = 1024 * 1024;

/**
 * The most fields one CSV row may hold. MAX_ROW_CHARS counts no delimiters, so a row of 26 million empty
 * fields passed it and took 11 seconds to read (review round 9); a ledger row holds a few dozen.
 */
const MAX_FIELDS = 10_000;

/**
 * The line of the first row with more than MAX_FIELDS fields, found before csv-parse reads the file:
 * delimiters outside quotes, counted per record (a line break inside quotes does not end one). Null when
 * every row is within the limit, or the delimiter is not one ASCII character.
 */
function rowWithTooManyFields(bytes: Uint8Array, delimiter: string): number | null {
  const d = delimiter.length === 1 ? delimiter.charCodeAt(0) : 0x80;
  if (d >= 0x80) return null;
  let quoted = false;
  let fields = 1;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    // A line ends at LF, or at a CR that no LF follows, as startLines counts them.
    if (b === 0x0a || (b === 0x0d && bytes[i + 1] !== 0x0a)) line += 1;
    if (b === 0x22) quoted = !quoted;
    else if (quoted) continue;
    else if (b === d) {
      fields += 1;
      if (fields > MAX_FIELDS) return rowLine;
    } else if (b === 0x0a || b === 0x0d) {
      fields = 1;
      rowLine = line;
    }
  }
  return null;
}

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
  const wide = rowWithTooManyFields(bytes, delimiter);
  if (wide !== null) {
    throw new ToolError('PARSE_ERROR', `Line ${wide}: a row holds more than ${MAX_FIELDS.toLocaleString('en-GB')} fields.`, 'Fix the CSV at that line (quotes must be doubled inside quoted fields), or pass the right delimiter.');
  }
  // Where each record ends (a byte offset), collected as records are read: a broken record starts
  // right after the last good one, which gives its line even though the parse failed.
  const ends: number[] = [];
  let records: string[][];
  try {
    records = parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      bom: true,
      delimiter,
      relax_column_count: false,
      max_record_size: MAX_ROW_CHARS,
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
  const indexes = mappedEntries(columns).map(([field, name]) => [field, findColumn(header, field, name, delimiter)] as const);
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

/** How many records the field names for hints are gathered from: a field the first record lacks still counts. */
const NAMED_RECORDS = 1000;

/**
 * The field names of the first NAMED_RECORDS JSON records, for hints, each once: their own fields, and
 * those beside each field a JSON Pointer maps (with "/amount/value" mapped, "/amount/currency" is named
 * too).
 */
function namesOf(records: readonly Record<string, unknown>[], columns: ColumnMap): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) names.add(key);
    for (const [, name] of mappedEntries(columns)) {
      if (!name.startsWith('/') || name.lastIndexOf('/') === 0) continue;
      const parent = name.slice(0, name.lastIndexOf('/'));
      const node = resolvePointer(record, parent);
      if (isRecord(node)) for (const key of Object.keys(node)) names.add(`${parent}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  }
  return [...names];
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
    const hint = near === undefined ? '' : ` Did you mean ${quoted(near, NAME_MAX)}?`;
    const shown = keys.slice(0, 30).map((k) => `${quoted(k)}`).join(', ');
    const fields = keys.length === 0 ? 'The first record has no fields.' : `The first record's fields are: ${shown}${keys.length > 30 ? ` and ${keys.length - 30} more` : ''}.`;
    throw new ToolError(
      'COLUMN_NOT_FOUND',
      `No record has the field ${quoted(name)} (mapped as ${field}).${hint} ${fields}`,
      'Map each field to a field the records have, or to a JSON Pointer such as "/amount/value" for a nested one.',
    );
  }
}

function parseOrThrow(text: string): unknown {
  try {
    return parseLedgerJson(text, MAX_DEPTH, jsonBudget());
  } catch (err) {
    if (err instanceof JsonLimitError) throw tooLarge(err);
    if (!(err instanceof JsonSyntaxError)) throw err;
    const at = /at position (\d+)$/.exec(err.message);
    const where = at?.[1] === undefined ? '' : (({ line, column }) => `Line ${line}, column ${column}: `)(lineColumn(text, Number(at[1])));
    throw new ToolError('PARSE_ERROR', `${where}the file is not valid JSON (${clip(err.message.replace(/ at position \d+$/, ''), 60)}).`, 'Fix the JSON, or pass format "jsonl" if the file holds one JSON object per line.');
  }
}

function readJson(text: string, columns: ColumnMap, recordsPointer: string): Ledger {
  const records = resolvePointer(parseOrThrow(text), recordsPointer);
  if (!Array.isArray(records)) {
    const where = recordsPointer === '' ? 'The top of the file' : `The value at ${quoted(recordsPointer, 80)}`;
    throw new ToolError('RECORDS_NOT_ARRAY', `${where} is ${describe(records)}, not an array of records.`, 'Pass records_pointer: the JSON Pointer of the array of ledger rows, such as "/data/entries".');
  }
  if (records.length > MAX_ROWS) throw tooManyRows();
  const rows = records.map((record: unknown, seq): LedgerRow => {
    const pointer = `${recordsPointer}/${seq}`;
    return isRecord(record) ? { seq, pointer, values: valuesOf(record, columns) } : { seq, pointer, values: {}, bad: 'the record is not a JSON object' };
  });
  const first = records.find(isRecord);
  requireMappedFields(rows, columns, first);
  return { rows, names: namesOf(records.filter(isRecord).slice(0, NAMED_RECORDS), columns) };
}

function readJsonl(text: string, columns: ColumnMap): Ledger {
  const rows: LedgerRow[] = [];
  const named: Array<Record<string, unknown>> = []; // the first NAMED_RECORDS records, for hints
  const lines = text.split('\n');
  const budget = jsonBudget(); // for the whole file, not each line
  for (const [i, raw] of lines.entries()) {
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (content.trim() === '') continue;
    if (rows.length === MAX_ROWS) throw tooManyRows();
    const base = { seq: rows.length, line: i + 1 };
    let value: unknown;
    try {
      value = parseLedgerJson(content, MAX_DEPTH, budget);
    } catch (err) {
      if (err instanceof JsonLimitError) throw tooLarge(err);
      if (!(err instanceof JsonSyntaxError)) throw err;
      rows.push({ ...base, values: {}, bad: 'the line is not valid JSON' });
      continue;
    }
    if (isRecord(value) && named.length < NAMED_RECORDS) named.push(value);
    rows.push(isRecord(value) ? { ...base, values: valuesOf(value, columns) } : { ...base, values: {}, bad: 'the line is not a JSON object' });
  }
  requireMappedFields(rows, columns, named[0]);
  return { rows, names: namesOf(named, columns) };
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
