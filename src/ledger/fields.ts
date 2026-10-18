// The fields of a ledger export's records (SPEC.md §4.2, §4.7): which ones the mapping names, the values it
// reads, and the hints a wrong mapping gets. Split from read.ts, which grew past 400 lines (review round 22).

import { closest } from '../closest.js';
import { clip, clipPath, ECHO_MAX, quoted } from '../echo.js';
import { ToolError } from '../errors.js';
import { JsonNumber } from './json.js';
import { decodeToken, encodeToken, isRecord, resolvePointer } from './pointer.js';
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
  if (names.includes(name)) return name;
  // As shown (cut, or escaped: review round 24), or with a quote in it written plainly, as a model reads \" (round 23).
  const shown = shownNames(names);
  const matches = names.filter((_, i) => shown[i] === name || shown[i]?.replaceAll('\\"', '"') === name);
  return matches.length === 1 ? (matches[0] ?? name) : name;
}

/**
 * How results show each of `names`, inside quotes: escaped and cut at 40 characters; where two would show
 * alike, each cut in the middle instead, so its end shows too (review round 23: two long headers that began
 * alike could not be told apart, nor either mapped). A JSON Pointer is shown token by token, each cut so
 * (review round 24: cut as a whole, "/money/currency_code_as_reported_by_the…" could not be passed back).
 * Where even the middle cuts show alike, each is marked with its place among them, " #1", " #2" (review
 * round 24: "Amount (minor units… settled by the bank" was both the debit and the credit column, and neither
 * could be mapped). The mark tells nothing past what is shown but the order of the names, and is never a
 * name another shows ("Phone #1" beside two "Phone": round 25). A name's shown form depends on the names
 * beside it: show each from the same list its resolver (`uncut`, `uncutPointer`) reads it back against.
 */
export function shownNames(names: readonly string[]): string[] {
  const parts = names.map(pointerParts);
  const cut = parts.map(([prefix, last]) => prefix + clip(last, ECHO_MAX, true));
  const cuts = tally(cut);
  const middle = parts.map(([prefix, last], i) => ((cuts.get(cut[i] ?? '') ?? 0) > 1 ? prefix + clipPath(last, ECHO_MAX, true) : (cut[i] ?? '')));
  const alike = tally(middle);
  const taken = new Set(middle);
  const seen = new Map<string, number>();
  return middle.map((m) => {
    if ((alike.get(m) ?? 0) < 2) return m;
    let n = seen.get(m) ?? 0;
    do n += 1;
    while (taken.has(`${m} #${n}`));
    seen.set(m, n);
    taken.add(`${m} #${n}`);
    return `${m} #${n}`;
  });
}

function tally(values: readonly string[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  return count;
}

/** Most tokens before the last that a pointer is shown token by token with; a longer name is cut as a whole. */
const SHOWN_TOKENS = 8;

/** A name as the tokens before its last, each shown cut, and its last token; for a name that is no pointer, "" and itself. */
function pointerParts(name: string): [prefix: string, last: string] {
  const tokens = name.startsWith('/') ? name.slice(1).split('/') : [];
  if (tokens.length === 0 || tokens.length > SHOWN_TOKENS + 1) return ['', name]; // a header cell of a thousand "/a" is cut at 40 too
  const last = tokens.pop() ?? '';
  return [`/${tokens.map((t) => `${clip(t, ECHO_MAX, true)}/`).join('')}`, last];
}

/**
 * A JSON Pointer passed back as a result showed it: each token its object lacks, given cut or escaped as
 * shown, resolved to the one key of that object shown so (review round 24: a records array or a nested
 * field under a key past 40 characters could not be reached). Unchanged where a token matches no key, or several.
 */
export function uncutPointer(pointer: string, doc: unknown): string {
  if (!pointer.startsWith('/')) return pointer;
  let node = doc;
  const out: string[] = [];
  for (const raw of pointer.slice(1).split('/')) {
    let token = raw;
    if (isRecord(node) && !Object.hasOwn(node, decodeToken(raw))) {
      const keys = Object.keys(node).map(encodeToken);
      if (keys.length <= MAX_UNCUT_KEYS) token = uncut(raw, keys);
    }
    out.push(token);
    const key = decodeToken(token);
    node = isRecord(node) && Object.hasOwn(node, key) ? node[key] : Array.isArray(node) && /^(?:0|[1-9]\d*)$/.test(key) ? node[Number(key)] : undefined;
  }
  return `/${out.join('/')}`;
}

/** Most keys an object may have for a token of a pointer to be matched against them as shown. */
const MAX_UNCUT_KEYS = 10_000;

/**
 * A pointer into `doc` as `uncutPointer` reads it back: each token shown as shownNames shows it among
 * the keys of its object (review round 25: shown on its own, a key beside a long "_meta" sibling was cut
 * at its head, and the pointer suggested led nowhere).
 */
export function shownPointer(pointer: string, doc: unknown): string {
  let node = doc;
  const out: string[] = [];
  for (const token of pointer.slice(1).split('/')) {
    const keys = isRecord(node) ? Object.keys(node).map(encodeToken) : [];
    const at = keys.length <= MAX_UNCUT_KEYS ? keys.indexOf(token) : -1;
    out.push(at >= 0 ? (shownNames(keys)[at] ?? '') : clip(token, ECHO_MAX, true));
    const key = decodeToken(token);
    node = isRecord(node) && Object.hasOwn(node, key) ? node[key] : Array.isArray(node) && /^(?:0|[1-9]\d*)$/.test(key) ? node[Number(key)] : undefined;
  }
  return `/${out.join('/')}`;
}

/**
 * The name `closest` suggests, judged only on what results show of each name, its first 40 characters
 * (review round 23: judged on the whole names, whether a suggestion came at all answered "does the hidden
 * part hold this?", and a secret past 40 characters came back one character a call).
 */
export function closestShown(name: string, names: readonly string[]): string | undefined {
  const shown = shownNames(names);
  const near = closest(name, shown);
  return near === undefined ? undefined : names[shown.indexOf(near)];
}

/**
 * " Did you mean \"…\"?", or nothing. When the name given and the one suggested look the same cut at 40
 * characters, say so, or the two read as a contradiction (review round 23). `near` is one of `names`, or
 * a pointer into `doc` built from its keys (nestedPointer), shown as uncutPointer reads it back.
 */
export function didYouMean(name: string, near: string | undefined, names: readonly string[], doc?: unknown): string {
  if (near === undefined) return '';
  const at = names.indexOf(near);
  const text = (at >= 0 ? shownNames(names)[at] : near.startsWith('/') && doc !== undefined ? shownPointer(near, doc) : shownNames([near])[0]) ?? '';
  const same = text === shownNames([name])[0] ? ' (it differs past the 40 characters shown: pass it back as shown)' : '';
  return ` Did you mean "${text}"${same}?`;
}

/**
 * The mapping with each name given as shown replaced by the name it meant: `uncut` against `names`, and a
 * pointer token by token against the first record (`uncutPointer`).
 */
export function uncutColumns(columns: ColumnMap, names: readonly string[], first?: Record<string, unknown>): ColumnMap {
  const out: ColumnMap = { ...columns };
  for (const [field, name] of mappedEntries(columns)) {
    const meant = uncut(name, names);
    out[field] = meant === name && first !== undefined ? uncutPointer(name, first) : meant;
  }
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
    const shown = shownNames(keys.map(encodeToken)).slice(0, 20).map((k) => `"${k}"`).join(', '); // in quotes: a key can hold ". Fix:"; among all the keys, as uncutPointer reads them back (round 25)
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
 * The pointer of a key beside the one `pointer` names, in the object its parent leads to in `record`,
 * close to its last token as shown ("/amount/currency" for {"amount": {"currency_code": …}}: review round 25).
 */
function siblingPointer(pointer: string, record: Record<string, unknown>): string | undefined {
  const parent = pointer.slice(0, pointer.lastIndexOf('/'));
  const node = parent === '' ? record : resolvePointer(record, parent);
  if (!isRecord(node)) return undefined;
  const keys = Object.keys(node).map(encodeToken);
  const near = keys.length <= MAX_UNCUT_KEYS ? closestShown(pointer.slice(parent.length + 1), keys) : undefined;
  return near === undefined ? undefined : `${parent}/${near}`;
}

/**
 * JSON and JSONL: a mapped field that no record has is a wrong mapping, not a problem in every row.
 * Report it once, with the first record's fields, as a missing CSV column is reported. `names` are the
 * field names the mapping was read back against (namesOf): each is shown, and suggested, as among them.
 */
export function requireMappedFields(rows: readonly LedgerRow[], columns: ColumnMap, first: Record<string, unknown> | undefined, names: readonly string[]): void {
  if (first === undefined) return; // no record is an object: each row says so already
  const good = rows.filter((row) => row.bad === undefined);
  for (const [field, name] of mappedEntries(columns)) {
    if (good.some((row) => row.values[field] !== undefined)) continue;
    const keys = Object.keys(first);
    const near = name.startsWith('/') ? (nestedPointer(name, first) ?? siblingPointer(name, first)) : (dottedPointer(name, first) ?? nestedPointer(name, first) ?? closestShown(name, names));
    const hint = didYouMean(name, near, names, first); // cut at 40 like every name shown (round 22)
    // Shown among all the names, as uncutColumns reads them back (round 25: shown among the first record's
    // keys alone, a key that a later record's key shares 39 characters with could not be passed back).
    const all = shownNames(names);
    const shown = keys.slice(0, 30).map((k) => `"${all[names.indexOf(k)] ?? ''}"`).join(', ');
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
