// The fields of a ledger export's records (SPEC.md §4.2, §4.7): which ones the mapping names, the values it
// reads, and the hints a wrong mapping gets. Split from read.ts, which grew past 400 lines (review round 22).

import { closest } from '../closest.js';
import { clip, ECHO_MAX, quoted } from '../echo.js';
import { ToolError } from '../errors.js';
import { JsonNumber } from './json.js';
import { encodeToken, isRecord, resolvePointer } from './pointer.js';
import type { ColumnMap, LedgerRow, MappedField } from './read.js';

export const MAPPED_FIELDS: readonly MappedField[] = ['transaction_id', 'amount', 'side', 'debit', 'credit', 'currency'];

export function mappedEntries(columns: ColumnMap): Array<[MappedField, string]> {
  return MAPPED_FIELDS.flatMap((field) => {
    const name = columns[field];
    return name === undefined ? [] : [[field, name] as [MappedField, string]];
  });
}

/**
 * The name a mapping meant, when it passed back a name as a result showed it, cut at 40 characters
 * ("Transaction Identifier For The General L…"): the one name that is shown so. Names are never shown
 * whole past 40 characters, as a first line may hold data, a secret among it (review round 22: a
 * suggestion of up to 200 characters gave back a whole token from 40 shown and a guess).
 */
export function uncut(name: string, names: readonly string[]): string {
  if (!name.endsWith('…') || names.includes(name)) return name;
  const matches = names.filter((n) => clip(n, ECHO_MAX, true) === name);
  return matches.length === 1 ? (matches[0] ?? name) : name;
}

/** The mapping with each name given cut replaced by the name it meant (`uncut`). */
export function uncutColumns(columns: ColumnMap, names: readonly string[]): ColumnMap {
  const out: ColumnMap = { ...columns };
  for (const [field, name] of mappedEntries(columns)) out[field] = uncut(name, names);
  return out;
}

/** How many records the field names for hints are gathered from: a field the first record lacks still counts. */
export const NAMED_RECORDS = 1000;

/**
 * The field names of the first NAMED_RECORDS JSON records, for hints, each once: their own fields, and
 * those beside each field a JSON Pointer maps (with "/amount/value" mapped, "/amount/currency" is named
 * too).
 */
export function namesOf(records: readonly Record<string, unknown>[], columns: ColumnMap): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) names.add(key);
    for (const [, name] of mappedEntries(columns)) {
      if (!name.startsWith('/') || name.lastIndexOf('/') === 0) continue;
      const parent = name.slice(0, name.lastIndexOf('/'));
      const node = resolvePointer(record, parent);
      if (isRecord(node)) for (const key of Object.keys(node)) names.add(`${parent}/${encodeToken(key)}`);
    }
  }
  return [...names];
}

export function valuesOf(record: Record<string, unknown>, columns: ColumnMap): Partial<Record<MappedField, unknown>> {
  const values: Partial<Record<MappedField, unknown>> = {};
  for (const [field, name] of mappedEntries(columns)) {
    values[field] = name.startsWith('/') ? resolvePointer(record, name) : Object.hasOwn(record, name) ? record[name] : undefined;
  }
  return values;
}

export function describe(value: unknown): string {
  if (value === undefined) return 'nothing (the pointer leads nowhere)';
  if (value === null) return 'null';
  if (isRecord(value)) {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 20).map((k) => quoted(k)).join(', '); // in quotes: a key can hold ". Fix:"
    return keys.length === 0 ? 'an empty object' : `an object with keys ${shown}${keys.length > 20 ? ', …' : ''}`;
  }
  return value instanceof JsonNumber ? 'a number' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/**
 * The pointer of a field one level down whose name is the last part of `name` ("id" or "meta/id" for
 * {"meta": {"id": …}}: "/meta/id"), the first in the record's order (review round 17).
 */
function nestedPointer(name: string, record: Record<string, unknown>): string | undefined {
  const last = name.split(/[/.]/).at(-1) ?? '';
  const parent = Object.keys(record).find((k) => { const v = record[k]; return isRecord(v) && Object.hasOwn(v, last); });
  return parent === undefined ? undefined : `/${[parent, last].map(encodeToken).join('/')}`;
}

/**
 * JSON and JSONL: a mapped field that no record has is a wrong mapping, not a problem in every row.
 * Report it once, with the first record's fields, as a missing CSV column is reported.
 */
export function requireMappedFields(rows: readonly LedgerRow[], columns: ColumnMap, first: Record<string, unknown> | undefined): void {
  if (first === undefined) return; // no record is an object: each row says so already
  const good = rows.filter((row) => row.bad === undefined);
  for (const [field, name] of mappedEntries(columns)) {
    if (good.some((row) => row.values[field] !== undefined)) continue;
    const keys = Object.keys(first);
    const near = name.startsWith('/') ? nestedPointer(name, first) : (dottedPointer(name, first) ?? nestedPointer(name, first) ?? closest(name, keys));
    const hint = near === undefined ? '' : ` Did you mean ${quoted(near)}?`; // cut at 40 like every name shown (round 22)
    const shown = keys.slice(0, 30).map((k) => `${quoted(k)}`).join(', ');
    const fields = keys.length === 0 ? 'The first record has no fields.' : `The first record's fields are: ${shown}${keys.length > 30 ? ` and ${keys.length - 30} more` : ''}.`;
    throw new ToolError(
      'COLUMN_NOT_FOUND',
      `No record has the field ${quoted(name)} (mapped as ${field}).${hint} ${fields}`,
      'Map each field to a field the records have, or to a JSON Pointer such as "/amount/value" for a nested one.',
    );
  }
}

/**
 * A dotted name ("txn.id") whose parts are nested fields of the record, as the JSON Pointer that reaches
 * them ("/txn/id"): the name a model tries first for a nested field (review round 12).
 */
function dottedPointer(name: string, record: Record<string, unknown>): string | undefined {
  const parts = name.split('.');
  if (parts.length < 2) return undefined;
  let value: unknown = record;
  for (const part of parts) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined; // its own fields, not "constructor" (round 13)
    value = value[part];
  }
  return `/${parts.map(encodeToken).join('/')}`;
}
