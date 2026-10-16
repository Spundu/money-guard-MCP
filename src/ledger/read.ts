// Reading a ledger export (SPEC.md §4.3) into rows holding just the mapped values and where each row
// is. File-level problems are ToolErrors; a bad record in JSON or JSONL becomes a row marked `bad`, so
// the check carries on and reports it with the rest.

import { CsvError, parse } from 'csv-parse/sync';
import { clip, ECHO_MAX, hasUnsafe, quoted } from '../echo.js';
import { MAX_FIELDS, MAX_ROW_CHARS, rowWithTooManyFields, startLines } from './csv-lines.js';
import { ToolError } from '../errors.js';
import { JsonLimitError, JsonSyntaxError, MAX_FIELD_NAMES, MAX_OBJECT_KEYS, parseLedgerJson, type JsonBudget } from './json.js';
import { closestShown, describe, didYouMean, shownNames, mappedEntries, NAMED_RECORDS, namesOf, requireMappedFields, uncut, uncutColumns, valuesOf } from './fields.js';
import { encodeToken, isRecord, resolvePointer } from './pointer.js';

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

/** Whether a header cell or a mapped name is written like a value ("999", "-12.50"), as a first row of data is (review round 20). */
export function looksLikeValue(name: string): boolean {
  return /^[-+]?\d[\d.,]*$/.test(name.trim());
}

/** `fromSepLine`: the delimiter came from the file's own "sep=" line, which the delimiter parameter cannot change. */
function findColumn(header: string[], field: MappedField, given: string, delimiter: string, fromSepLine = false): number {
  const name = uncut(given, header); // a name passed back as a result showed it, cut
  const exact = header.flatMap((h, i) => (h === name ? [i] : []));
  const matches = exact.length > 0 ? exact : header.flatMap((h, i) => (h.toLowerCase() === name.toLowerCase() ? [i] : []));
  if (matches.length === 1) return matches[0] ?? -1;
  if (matches.length > 1) {
    throw new ToolError('COLUMN_AMBIGUOUS', `The header has ${matches.length} columns named ${quoted(name)} (mapped as ${field}).`, 'Rename one of them in the export, or map a different column.');
  }
  const shown = shownNames(header).slice(0, 30).map((h) => `"${h}"`);
  const more = header.length > 30 ? ` and ${header.length - 30} more` : '';
  const near = closestShown(name, header.filter((h) => h !== '')); // never an empty name, from a trailing delimiter (round 14); on what is shown (round 23)
  const hint = didYouMean(name, near, header); // cut at 40 like every name shown (round 22)
  // A header read as one column that holds another delimiter: the file is separated by that one.
  // The one that occurs most in the header, read as one column, is the likeliest delimiter.
  const count = (d: string) => (header[0] ?? '').split(d).length - 1;
  const other = header.length === 1 ? DELIMITERS.filter((d) => d !== delimiter && count(d) > 0).sort((x, y) => count(y) - count(x))[0] : undefined;
  // A sep= first line in a form money-guard does not read (review round 14: the delimiter hint led to a second error).
  const sepFirst = /^sep\s*=/i.test(header[0] ?? ''); // "sep = ;" too (round 15)
  // A file with no header line: its first row is read as the names (review round 20). A real header may have a
  // name like "2023" (round 21): said as a possibility, with the closest match kept.
  const data = header.find(looksLikeValue);
  throw new ToolError(
    'COLUMN_NOT_FOUND',
    `The CSV header has no column ${quoted(name)} (mapped as ${field}).${sepFirst ? '' : hint} The columns are: ${shown.join(', ')}${more}.${data === undefined ? '' : ` The first line holds ${quoted(data)}, written like a value: the first line is always read as the column names, so a file without a header line loses its first row.`}`,
    sepFirst
      ? SEP_FIX
      : data !== undefined && other === undefined
      ? 'Map each field to one of the column names in the header; if the file has no header line, add one that names the columns first.'
      : other === undefined
      ? 'Map each field to one of the column names in the header.'
      : fromSepLine
        ? `The file looks separated by ${showDelimiter(other)}, but its first line, sep=, names ${showDelimiter(delimiter)}, which wins over the delimiter parameter: fix or remove that line.`
        : `The file looks separated by ${showDelimiter(other)}, not ${showDelimiter(delimiter)}: pass delimiter ${JSON.stringify(other)}.`,
  );
}

/**
 * The delimiter a header holds when it holds none of `delimiter`: the one it holds most (review round 16:
 * a semicolon export with comma decimals failed on line 2, before the header's hint could run).
 */
function headerDelimiter(bytes: Uint8Array, delimiter: string): string | undefined {
  const first = new TextDecoder().decode(bytes.subarray(0, 4096)).split(/\r\n?|\n/)[0] ?? '';
  if (first.includes(delimiter)) return undefined;
  const count = (d: string) => first.split(d).length - 1;
  return DELIMITERS.filter((d) => d !== delimiter && count(d) > 0).sort((x, y) => count(y) - count(x))[0];
}

/** For a first line that starts sep= in a form readCsv does not read: whatever the delimiter, it misleads (review round 14). */
const SEP_FIX = 'The first line looks like Excel\'s "sep=" line, in a form money-guard does not read (sep= then one of , ; | or a tab): delete that line, or write it so.';

const CSV_PROBLEMS: Readonly<Record<string, string>> = {
  CSV_QUOTE_NOT_CLOSED: 'a quoted field is never closed',
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: 'the row does not have as many fields as the header',
  CSV_INVALID_CLOSING_QUOTE: 'a quote closes in the middle of a field',
  CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: 'text follows a closing quote',
  INVALID_OPENING_QUOTE: 'a quote opens in the middle of a field',
  CSV_MAX_RECORD_SIZE: 'a row holds more than 1 MiB of values',
};

function readCsv(bytes: Uint8Array, columns: ColumnMap, given: string): Ledger {
  // A first line "sep=;", which Excel reads (tools that write CSV for Excel add it), names the delimiter and is not the header
  // (review round 13). It is skipped, and its delimiter used; lines are still counted from the file's first.
  // Quoted, or with spaces after; the BOM kept, so its 3 bytes count (round 14); or the whole file, with no line end (round 16).
  const head = bytes.subarray(0, 24);
  const sepLine = new RegExp(`^(?:\\uFEFF)?"?sep=([,;\\t|])"?[ \\t]*(?:\\r\\n?|\\n${head.length === bytes.length ? '|$' : ''})`, 'i').exec(new TextDecoder('utf-8', { ignoreBOM: true }).decode(head));
  const delimiter = sepLine?.[1] ?? given;
  const sepEnd = sepLine === null ? 0 : Buffer.byteLength(sepLine[0]);
  const lineStarts = (list: readonly number[]) => (sepEnd === 0 ? startLines(bytes, list) : startLines(bytes, [sepEnd, ...list]).slice(1));
  const wide = rowWithTooManyFields(bytes, delimiter);
  if (wide !== null) {
    throw new ToolError('PARSE_ERROR', `Line ${wide}: a row holds more than ${MAX_FIELDS.toLocaleString('en-GB')} fields.`, 'Fix the CSV at that line (quotes must be doubled inside quoted fields), or pass the right delimiter.');
  }
  // Where each record ends (a byte offset), collected as records are read: a broken record starts
  // right after the last good one, which gives its line even though the parse failed.
  const ends: number[] = [];
  let records: string[][];
  try {
    // The data after the sep= line, so that its line end does not decide the others' (review round 15: a
    // "sep=;" CR line before LF lines read the whole file as one record). Offsets count from the file's start.
    records = parse(Buffer.from(bytes.buffer, bytes.byteOffset + sepEnd, bytes.byteLength - sepEnd), {
      bom: true,
      delimiter,
      relax_column_count: false,
      max_record_size: MAX_ROW_CHARS,
      skip_empty_lines: true,
      trim: true,
      to: MAX_ROWS + 2, // the header, the limit, and one more to detect "too many"
      on_record: (record: string[], context: { bytes: number }) => {
        ends.push(sepEnd + context.bytes);
        return record;
      },
    }) as string[][];
  } catch (err) {
    if (!(err instanceof CsvError)) throw err;
    const line = lineStarts([...ends, bytes.length]).at(-1) ?? 1;
    const problem = CSV_PROBLEMS[err.code] ?? 'the CSV structure is broken';
    const unreadSep = sepEnd === 0 && /^(?:\uFEFF)?"?sep\s*=/i.test(new TextDecoder().decode(bytes.subarray(0, 16)));
    const other = unreadSep ? undefined : headerDelimiter(bytes.subarray(sepEnd), delimiter);
    const fix = other === undefined ? 'Fix the CSV at that line (quotes must be doubled inside quoted fields), or pass the right delimiter.' : `The header looks separated by ${showDelimiter(other)}, not ${showDelimiter(delimiter)}: pass delimiter ${JSON.stringify(other)}.`;
    throw new ToolError('PARSE_ERROR', `Line ${line}: ${problem}.`, unreadSep ? SEP_FIX : fix);
  }
  const [header, ...data] = records;
  if (header === undefined) return { rows: [], names: [] };
  if (data.length > MAX_ROWS) throw tooManyRows();
  const indexes = mappedEntries(columns).map(([field, name]) => [field, findColumn(header, field, name, delimiter, sepEnd > 0)] as const);
  const lines = lineStarts(ends);
  const rows = data.map((record, seq) => {
    const values: Partial<Record<MappedField, unknown>> = {};
    for (const [field, index] of indexes) values[field] = record[index];
    return { seq, line: lines[seq + 1] ?? 0, values };
  });
  return { rows, names: header };
}

// --------------------------------------------------------------------------------------------- JSON

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
    // One field that holds an array is very likely the rows: name its pointer (review round 18).
    const arrays = isRecord(records) ? Object.keys(records).filter((k) => Array.isArray(records[k])) : [];
    // Only one that can be passed back as it is shown: whole, with no character records_pointer refuses (round 19),
    // none that quotes show escaped, a backslash or a double quote (round 20), and none past 40 characters,
    // which a key could make a secret of (round 22).
    const one = arrays.length === 1 ? `${recordsPointer}/${encodeToken(arrays[0] ?? '')}` : undefined;
    const only = one !== undefined && one.length <= ECHO_MAX && !hasUnsafe(one) && !/["\\]/.test(one) ? one : undefined;
    throw new ToolError('RECORDS_NOT_ARRAY', `${where} is ${describe(records)}, not an array of records.`, only === undefined ? 'Pass records_pointer: the JSON Pointer of the array of ledger rows, such as "/data/entries".' : `Pass records_pointer ${quoted(only)}, the one field there that holds an array.`);
  }
  if (records.length > MAX_ROWS) throw tooManyRows();
  const first = records.find(isRecord);
  columns = first === undefined ? columns : uncutColumns(columns, Object.keys(first));
  const rows = records.map((record: unknown, seq): LedgerRow => {
    const pointer = `${recordsPointer}/${seq}`;
    return isRecord(record) ? { seq, pointer, values: valuesOf(record, columns) } : { seq, pointer, values: {}, bad: 'the record is not a JSON object' };
  });
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
    if (isRecord(value) && named.length === 0) columns = uncutColumns(columns, Object.keys(value)); // names as the first record has them
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
