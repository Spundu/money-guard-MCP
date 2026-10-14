// audit_verify_chain's core (SPEC.md §5): bytes in, result out. No file system, no settings: the
// tool layer reads the file and passes the configured keys.

import { createHash } from 'node:crypto';
import { GENESIS_HASH, jsonlEntryAt, jsonlLineCount, verifyJsonl } from 'sealed-audit-chain';
import type { AuditKeys } from '../config.js';
import { clip, escapeUnsafe } from '../echo.js';

export type ReasonCode =
  | 'TORN_LAST_LINE'
  | 'LINE_TOO_LARGE'
  | 'NOT_UTF8'
  | 'NOT_JSON'
  | 'NOT_CANONICAL'
  | 'OUTSIDE_CANONICAL_DOMAIN'
  | 'NOT_AN_OBJECT'
  | 'SEQ_MISMATCH'
  | 'LINK_BROKEN'
  | 'NOT_CANONICALIZABLE'
  | 'CONTENT_TAMPERED'
  | 'UNKNOWN_KEY_ID'
  | 'HMAC_MISMATCH'
  | 'ENTRY_TOO_LARGE'
  | 'ANCHOR_COUNT_MISMATCH'
  | 'ANCHOR_HEAD_MISMATCH'
  | 'OTHER';

export interface Anchor {
  count: number;
  last_hash: string;
}

export interface AuditBreak {
  entry_index: number;
  /** entry_index + 1, or null when the log has no such line (an anchor counting more entries). */
  line: number | null;
  code: ReasonCode;
  /** sealed-audit-chain's own wording (or money-guard's, for an anchor), cut at MAX_REASON characters. */
  reason: string;
  writer_key_id?: string;
}

export interface AuditResult {
  summary: string;
  file: string;
  file_sha256: string;
  ok: boolean;
  entries_verified: number;
  break: AuditBreak | null;
  anchor_checked: boolean;
  head: Anchor | null;
  key_ids_configured: string[];
  notes: string[];
}

/** sealed-audit-chain's fixed reasons. SPEC.md §5.4; test/audit.test.ts proves the list is complete. */
const EXACT: Readonly<Record<string, ReasonCode>> = {
  'last line is not terminated (torn)': 'TORN_LAST_LINE',
  'line exceeds the canonical size limit': 'LINE_TOO_LARGE',
  'line is not valid UTF-8': 'NOT_UTF8',
  'line is not valid JSON': 'NOT_JSON',
  'line is not in canonical form': 'NOT_CANONICAL',
  'line is outside the canonical domain': 'OUTSIDE_CANONICAL_DOMAIN',
  'entry is not an object': 'NOT_AN_OBJECT',
  'prev_hash linkage broken (reorder/delete)': 'LINK_BROKEN',
  'entry_hash mismatch (content tampered)': 'CONTENT_TAMPERED',
  'unknown writer_key_id': 'UNKNOWN_KEY_ID',
  'HMAC mismatch (forged or unsealed)': 'HMAC_MISMATCH',
  'entry exceeds the canonical size limit': 'ENTRY_TOO_LARGE',
  'head hash does not match anchor': 'ANCHOR_HEAD_MISMATCH',
};

/** The stable code for one of sealed-audit-chain's reasons; OTHER only for a reason this version does not know. */
export function reasonCode(reason: string): ReasonCode {
  if (Object.hasOwn(EXACT, reason)) return EXACT[reason] ?? 'OTHER';
  if (/^seq mismatch: expected \d+$/.test(reason)) return 'SEQ_MISMATCH';
  if (reason.startsWith('not canonicalizable: ')) return 'NOT_CANONICALIZABLE';
  if (/^count \d+ != anchor count \(truncation\)$/.test(reason)) return 'ANCHOR_COUNT_MISMATCH';
  return 'OTHER';
}

/** What happened to an entry, as it reads after "entry 3 (line 4)". */
const ENTRY_MEANING: Readonly<Record<Exclude<ReasonCode, 'ANCHOR_COUNT_MISMATCH' | 'ANCHOR_HEAD_MISMATCH' | 'OTHER'>, string>> = {
  TORN_LAST_LINE: 'is cut off: its line does not end with a newline (an interrupted write, or a truncated file)',
  LINE_TOO_LARGE: 'is longer than any sealed entry can be',
  NOT_UTF8: 'is not valid UTF-8 text',
  NOT_JSON: 'is not valid JSON',
  NOT_CANONICAL: 'was rewritten (spacing, key order or escapes changed), so its bytes are not the ones that were sealed',
  OUTSIDE_CANONICAL_DOMAIN: 'holds values a sealed entry cannot hold (floats, unsafe integers, lone surrogates or deep nesting)',
  NOT_AN_OBJECT: 'is not a JSON object',
  SEQ_MISMATCH: 'has the wrong sequence number: entries were inserted, removed or reordered',
  LINK_BROKEN: 'does not link to the entry before it: entries were reordered or removed',
  NOT_CANONICALIZABLE: 'cannot be put in canonical form',
  CONTENT_TAMPERED: 'was edited after it was sealed',
  UNKNOWN_KEY_ID: 'names a key id that is not configured',
  HMAC_MISMATCH: 'has a seal that does not match: it was forged, or sealed with a different key',
  ENTRY_TOO_LARGE: 'is larger than a sealed entry can be',
};

/** The longest reason a result repeats (SPEC.md §5.5); every fixed library reason is shorter. */
const MAX_REASON = 120;

const NO_ANCHOR_NOTE = 'No anchor was given, so entries removed from the end cannot be detected.';
const EMPTY_NOTE = 'The log is empty. An empty log always verifies; pass an anchor to detect a deleted or emptied log.';

/** Number of lines in the file, counting an unterminated last line. */
function lineCount(bytes: Uint8Array): number {
  return jsonlLineCount(bytes) + (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? 1 : 0);
}

function writerKeyIdAt(bytes: Uint8Array, index: number): string | undefined {
  const entry = jsonlEntryAt(bytes, index);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const id = (entry as Record<string, unknown>).writer_key_id;
  return typeof id === 'string' ? clip(id, 64) : undefined;
}

function entries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

/** The 1-based line of the first CR LF line end in the file, or null. A canonical entry never holds a raw CR. */
function firstCrlfLine(bytes: Uint8Array): number | null {
  let line = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) line += 1;
    else if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) return line;
  }
  return null;
}

function crlfNote(line: number): string {
  return (
    `Line ${line} ends with CR LF. A sealed log is written with LF line ends only, so its line ends were converted after it was sealed, ` +
    'for example by git with core.autocrlf on Windows. Restore the original file (in git, mark the log -text in .gitattributes); do not re-seal it.'
  );
}

/** The entry_hash of entry `index` of a log that verified. */
function entryHashAt(bytes: Uint8Array, index: number): string {
  return (jsonlEntryAt(bytes, index) as { entry_hash: string }).entry_hash;
}

type MakeResult = (summary: string, brk: AuditBreak | null, head: Anchor | null, anchorChecked: boolean) => AuditResult;

/**
 * The result for an anchor whose last entry is not the one it recorded (entry count - 1 of a log whose
 * entries up to there verified), or null when it is. A count of 0 goes with the genesis hash.
 */
function headMismatch(bytes: Uint8Array, anchor: Anchor, result: MakeResult): AuditResult | null {
  const anchored = anchor.count === 0 ? GENESIS_HASH : entryHashAt(bytes, anchor.count - 1);
  if (anchored === anchor.last_hash) return null;
  const index = Math.max(anchor.count - 1, 0);
  const brk: AuditBreak =
    anchor.count === 0
      ? { entry_index: 0, line: null, code: 'ANCHOR_HEAD_MISMATCH', reason: 'anchor count 0 needs the genesis hash' }
      : { entry_index: index, line: anchor.count, code: 'ANCHOR_HEAD_MISMATCH', reason: `entry ${index} hash does not match anchor` };
  const what =
    anchor.count === 0
      ? 'the anchor cannot be the head of any log: a count of 0 goes with the genesis hash'
      : `entry ${index} (line ${anchor.count}) is not the one the anchor recorded: the log was replaced or rewritten`;
  return result(`The log does NOT verify: ${what} (ANCHOR_HEAD_MISMATCH).`, brk, null, true);
}

export function verifyAuditLog(input: { file: string; bytes: Uint8Array; keys: AuditKeys; anchor?: Anchor | undefined }): AuditResult {
  const { file, bytes, keys, anchor } = input;
  // The chain on its own: every seal and every link. The anchor is checked after, here: the library's
  // anchor pins the LAST entry, which suits a head the writer stores at each append, while an anchor
  // given to this tool is a head from an earlier run, which an honest log grows past (SPEC.md §5.3).
  const verdict = verifyJsonl(bytes, keys.provider);
  const notes: string[] = [];
  if (!anchor && bytes.length === 0) notes.push(EMPTY_NOTE);
  if (!anchor) notes.push(NO_ANCHOR_NOTE);
  // The fields in SPEC.md §5.5's order.
  const result: MakeResult = (summary, brk, head, anchorChecked) => ({
    summary,
    file,
    file_sha256: createHash('sha256').update(bytes).digest('hex'),
    ok: brk === null,
    entries_verified: brk === null ? verdict.lastSeq + 1 : brk.entry_index,
    break: brk,
    anchor_checked: anchorChecked,
    head,
    key_ids_configured: keys.ids.map(escapeUnsafe), // from the settings, but shown like any other text
    notes,
  });

  if (!verdict.ok) return broken(bytes, verdict, anchor, notes, result);

  const count = verdict.lastSeq + 1;
  const head: Anchor = { count, last_hash: count === 0 ? GENESIS_HASH : entryHashAt(bytes, count - 1) };
  const intact = count === 0 ? 'The log is empty, which always verifies.' : `The log verifies: ${entries(count)}, every seal and link intact.`;
  if (!anchor) return result(`${intact}${count === 0 ? '' : ' Keep head and pass it as anchor next time.'}`, null, head, false);

  if (anchor.count > count) {
    const brk: AuditBreak = { entry_index: count, line: null, code: 'ANCHOR_COUNT_MISMATCH', reason: `count ${count} < anchor count ${anchor.count} (truncation)` };
    const what = `the log has ${entries(count)} but the anchor says ${anchor.count}: entries were removed from the end, or the log was replaced`;
    return result(`The log does NOT verify: ${what} (ANCHOR_COUNT_MISMATCH).`, brk, null, true);
  }
  const replaced = headMismatch(bytes, anchor, result);
  if (replaced) return replaced;
  const added = count - anchor.count;
  const tail = added === 0 ? ' It matches the anchor.' : ` It extends the anchor: ${entries(added)} added since; keep the new head for next time.`;
  return result(`${intact}${tail}`, null, head, true);
}

/**
 * The result for a log whose chain breaks: the first broken entry, and why, in plain words. The entries
 * before the break verified, so an anchor that covers only them is still checked: a replaced log must
 * not hide behind a later break that looks like an accident (a torn last line).
 */
function broken(bytes: Uint8Array, verdict: { brokenAt: number | null; reason: string | null }, anchor: Anchor | undefined, notes: string[], result: MakeResult): AuditResult {
  const index = verdict.brokenAt ?? 0;
  const crlf = firstCrlfLine(bytes);
  if (crlf !== null) notes.push(crlfNote(crlf));
  const anchorChecked = anchor !== undefined && anchor.count <= index;
  if (anchor && anchorChecked) {
    const replaced = headMismatch(bytes, anchor, result);
    if (replaced) return replaced;
    notes.push('The entries the anchor covers are intact; the break comes after them.');
  } else if (anchor) {
    notes.push('The anchor was not checked: the chain breaks at or before the last entry it covers, so entries it vouched for are damaged or gone.');
  }
  const raw = verdict.reason ?? 'unknown';
  const code = reasonCode(raw);
  // The library's fixed reasons are short; a canonicalization error can quote a key name from the line,
  // so the reason is cut like any other text from the file.
  const reason = clip(raw, MAX_REASON);
  const line = index < lineCount(bytes) ? index + 1 : null;
  const brk: AuditBreak = { entry_index: index, line, code, reason };
  if (code === 'UNKNOWN_KEY_ID' || code === 'HMAC_MISMATCH') {
    const id = writerKeyIdAt(bytes, index);
    if (id !== undefined) brk.writer_key_id = id;
  }

  const where = line === null ? `entry ${index}` : `entry ${index} (line ${line})`;
  let meaning: string;
  if (code === 'NOT_CANONICAL' && crlf === line) {
    meaning = 'ends with CR LF where the sealed log has LF: its line ends were converted after it was sealed';
  } else if (code === 'OTHER' || code === 'ANCHOR_COUNT_MISMATCH' || code === 'ANCHOR_HEAD_MISMATCH') {
    meaning = `failed: ${reason}`; // anchor codes cannot come from the library here: it is given no anchor
  } else {
    meaning = ENTRY_MEANING[code];
  }
  const keyId = code === 'UNKNOWN_KEY_ID' && brk.writer_key_id !== undefined ? ` ("${brk.writer_key_id}")` : '';
  return result(`The log does NOT verify: ${where} ${meaning}${keyId} (${code}).`, brk, null, anchorChecked);
}
