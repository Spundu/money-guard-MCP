// audit_verify_chain's core (SPEC.md §5): bytes in, result out. No file system, no settings: the
// tool layer reads the file and passes the configured keys.

import { createHash } from 'node:crypto';
import { GENESIS_HASH, jsonlEntryAt, jsonlLineCount, verifyJsonl } from 'sealed-audit-chain';
import type { AuditKeys } from '../config.js';
import { clip, escapeUnsafe, quoted } from '../echo.js';

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
  return typeof id === 'string' ? id : undefined; // raw: clipped for the result, quoted for the summary
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

/** The result for an anchor that counts more entries than the log holds, each of them whole. */
function countMismatch(count: number, anchor: Anchor, result: MakeResult): AuditResult {
  const brk: AuditBreak = { entry_index: count, line: null, code: 'ANCHOR_COUNT_MISMATCH', reason: `count ${count} < anchor count ${anchor.count} (truncation)` };
  const what = `the log has ${entries(count)} but the anchor says ${anchor.count}: entries were removed from the end, or the log was replaced`;
  return result(`The log does NOT verify: ${what} (ANCHOR_COUNT_MISMATCH).`, brk, null, true);
}

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

/** Whether the log starts with UTF-8's byte order mark, EF BB BF. */
function startsWithBom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function verifyAuditLog(input: { file: string; bytes: Uint8Array; keys: AuditKeys; anchor?: Anchor | undefined }): AuditResult {
  const { file, bytes, keys, anchor } = input;
  // The chain on its own: every seal and every link. The anchor is checked after, here: the library's
  // anchor pins the LAST entry, which suits a head the writer stores at each append, while an anchor
  // given to this tool is a head from an earlier run, which an honest log grows past (SPEC.md §5.3).
  // A log whose last line has no LF is read once, with the LF added (review round 14: it was read twice,
  // 8 s for 100 MiB). The entries before that line are the same bytes either way, so a break before it is
  // the same break. At that line, a line that does not read as JSON is torn (an interrupted write); a whole
  // entry that fails its hash, seal or link keeps that answer, as it would with its LF (review round 15:
  // an edited or forged last entry without its LF read as an interrupted write).
  const completed = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? Buffer.concat([bytes, Buffer.from('\n')]) : null;
  const read = verifyJsonl(completed ?? bytes, keys.provider);
  const tornAt = completed === null ? -1 : jsonlLineCount(bytes);
  const brokenAtLast = completed !== null && !read.ok && (read.brokenAt ?? 0) >= tornAt;
  // A BOM breaks the first line whatever follows it (review round 19: Notepad's BOM and no final LF read as cut off).
  const bom = startsWithBom(bytes);
  // Whole if it reads as an entry without the BOM (review round 20: a BOM before a cut-off line was called whole).
  const wholeWithoutBom = () => {
    const again = verifyJsonl(Buffer.concat([bytes.subarray(3), Buffer.from('\n')]), keys.provider);
    return bytes.length === 3 || again.ok || !TORN_LIKE.has(reasonCode(again.reason ?? '')); // a BOM alone is no cut-off write (round 21)
  };
  const wholeButBom = brokenAtLast && TORN_LIKE.has(reasonCode(read.reason ?? '')) && bom && wholeWithoutBom();
  const lastIsWhole = brokenAtLast && (!TORN_LIKE.has(reasonCode(read.reason ?? '')) || wholeButBom);
  const verdict = completed === null || (!read.ok && (read.brokenAt ?? 0) < tornAt) || lastIsWhole ? read : { ok: false, lastSeq: tornAt - 1, brokenAt: tornAt, reason: TORN_REASON };
  const notes: string[] = [];
  // Round 21: one that the BOM alone breaks is not called whole beside "not valid JSON".
  if (lastIsWhole) notes.push(bytes.length === 3 && bom ? BOM_ONLY_NOTE : wholeButBom ? NO_FINAL_NEWLINE_BOM_NOTE : NO_FINAL_NEWLINE_TOO_NOTE);
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
    key_ids_configured: keys.ids.map((id) => escapeUnsafe(id)), // from the settings, but shown like any other text
    notes,
  });

  // A log whose only fault is a missing final LF (an editor or a copy can drop it) keeps every entry:
  // say so, instead of "cut short" (review round 13). With an anchor, only when the completed log still
  // holds the entries it covers, ending in the entry it recorded: otherwise entries were removed or the
  // log replaced as well, and the anchor checks say so (review round 14).
  const onlyFinalNewline = completed !== null && read.ok;
  if (onlyFinalNewline && anchor) {
    // Every entry is whole: entries are gone after the last, as with the LF kept (review round 15).
    if (anchor.count > read.lastSeq + 1) {
      notes.push(NO_FINAL_NEWLINE_TOO_NOTE);
      return countMismatch(read.lastSeq + 1, anchor, result);
    }
    const replaced = headMismatch(completed, anchor, result);
    if (replaced) {
      notes.push(NO_FINAL_NEWLINE_TOO_NOTE); // as with a count mismatch (review round 16); the result holds this array
      return replaced;
    }
  }
  if (!verdict.ok) return broken(bytes, verdict, anchor, notes, result, onlyFinalNewline, completed ?? bytes);

  const count = verdict.lastSeq + 1;
  const head: Anchor = { count, last_hash: count === 0 ? GENESIS_HASH : entryHashAt(bytes, count - 1) };
  const intact = count === 0 ? 'The log is empty, which always verifies.' : `The log verifies: ${entries(count)}, every seal and link intact.`;
  if (!anchor) return result(`${intact}${count === 0 ? '' : ' Keep head and pass it as anchor next time.'}`, null, head, false);

  if (anchor.count > count) return countMismatch(count, anchor, result);
  const replaced = headMismatch(bytes, anchor, result);
  if (replaced) return replaced;
  const added = count - anchor.count;
  const tail = added === 0 ? ' It matches the anchor.' : ` It extends the anchor: ${entries(added)} added since; keep the new head for next time.`;
  return result(`${intact}${tail}`, null, head, true);
}

/** What a last line without LF that does not read as an entry fails with, once an LF is added: it is torn. */
const TORN_LIKE: ReadonlySet<ReasonCode> = new Set(['NOT_JSON', 'NOT_UTF8', 'LINE_TOO_LARGE']);

const NO_FINAL_NEWLINE_TOO_NOTE = 'The last line also lacks its line end (LF); the entry on it is whole, so it was checked as it stands.';
const NO_FINAL_NEWLINE_BOM_NOTE = 'The last line also lacks its line end (LF); it is not a cut-off write, as the line is whole without the byte order mark that breaks it.';
/** Round 22: no line to call whole. */
const BOM_ONLY_NOTE = 'The file holds only a byte order mark, no entry.';

/** sealed-audit-chain's reason for a last line without LF (its jsonl.js). */
const TORN_REASON = 'last line is not terminated (torn)';

const ANCHOR_WITH_NEWLINE_NOTE = 'The anchor matches the log once the line end after its last entry is restored.';

const FINAL_NEWLINE_NOTE = 'Only the line end after the last entry is missing: with it, every entry verifies. A sealed log ends each line with LF; an editor or a copy may have dropped the last one.';

const BOM_NOTE = 'The file starts with a byte order mark (EF BB BF), which a sealed log never has: an editor may have added it when the file was saved. Remove those three bytes from a copy and check the copy.';

const KEY_SETTING_NOTE = 'A wrong key setting gives this answer too, for an untouched log: check that MONEY_GUARD_AUDIT_KEYS holds the key that sealed the log before calling it tampered.';

/**
 * The result for a log whose chain breaks: the first broken entry, and why, in plain words. The entries
 * before the break verified, so an anchor that covers only them is still checked: a replaced log must
 * not hide behind a later break that looks like an accident (a torn last line).
 */
/** `entryBytes`: the log with its last LF, if it lacked one, from which an entry's key id is read (review round 16). */
function broken(bytes: Uint8Array, verdict: { brokenAt: number | null; reason: string | null }, anchor: Anchor | undefined, notes: string[], result: MakeResult, onlyFinalNewline = false, entryBytes: Uint8Array = bytes): AuditResult {
  const index = verdict.brokenAt ?? 0;
  const crlf = firstCrlfLine(bytes);
  if (crlf !== null) notes.push(crlfNote(crlf));
  // An editor can add a byte order mark when it saves the file, as it can CR LF (review round 18).
  if (index === 0 && startsWithBom(bytes)) notes.push(BOM_NOTE);
  const anchorChecked = anchor !== undefined && (anchor.count <= index || onlyFinalNewline);
  const raw = verdict.reason ?? 'unknown';
  const code = reasonCode(raw);
  if (anchor && onlyFinalNewline) {
    // The completed log matched the anchor (verifyAuditLog checked it). An anchor that covers the entry
    // without its LF does not end before the break (review round 15).
    if (anchor.count > index) notes.push(ANCHOR_WITH_NEWLINE_NOTE);
    else if (anchor.count > 0) notes.push('The entries the anchor covers are intact; the break comes after them.'); // count 0 covers none
  } else if (anchor && anchorChecked) {
    const replaced = headMismatch(bytes, anchor, result);
    if (replaced) return replaced;
    if (anchor.count > 0) notes.push('The entries the anchor covers are intact; the break comes after them.'); // count 0 covers none
  } else if (anchor && code === 'TORN_LAST_LINE') {
    // The anchor proves the entries before its count were once whole: a log that ends inside one of them
    // was cut short, not interrupted while writing (review round 12).
    notes.push(`The anchor covers ${entries(anchor.count)}, but the log ends inside entry ${index}: it was cut short, and entries the anchor vouched for are gone.`);
  } else if (anchor) {
    notes.push('The anchor was not checked: the chain breaks at or before the last entry it covers, so the entries it vouched for could not be checked.');
  }
  if (onlyFinalNewline) notes.push(FINAL_NEWLINE_NOTE);
  // The library's fixed reasons are short; a canonicalization error can quote a key name from the line,
  // so the reason is cut like any other text from the file.
  const reason = clip(raw, MAX_REASON);
  const line = index < lineCount(bytes) ? index + 1 : null;
  const brk: AuditBreak = { entry_index: index, line, code, reason };
  const rawKeyId = code === 'UNKNOWN_KEY_ID' || code === 'HMAC_MISMATCH' ? writerKeyIdAt(entryBytes, index) : undefined;
  if (rawKeyId !== undefined) brk.writer_key_id = clip(rawKeyId, 64);
  // An unknown key id, or a seal that fails from the first entry of its key (the first entry, or the first
  // after a key change), is what a wrong key setting gives an untouched log (review rounds 11 and 12):
  // say so, so that the setting is checked before tampering is reported.
  const firstOfItsKey = index === 0 || (rawKeyId !== undefined && writerKeyIdAt(entryBytes, index - 1) !== rawKeyId);
  if (code === 'UNKNOWN_KEY_ID' || (code === 'HMAC_MISMATCH' && firstOfItsKey)) notes.push(KEY_SETTING_NOTE);

  const where = line === null ? `entry ${index}` : `entry ${index} (line ${line})`;
  let meaning: string;
  if (code === 'NOT_CANONICAL' && crlf === line) {
    meaning = 'ends with CR LF where the sealed log has LF: its line ends were converted after it was sealed';
  } else if (onlyFinalNewline) {
    // The summary, read first, must not say "a truncated file" while the notes say every entry verifies (round 14).
    meaning = 'lacks the line end a sealed log puts after every entry; with it, every entry verifies';
  } else if (code === 'OTHER' || code === 'ANCHOR_COUNT_MISMATCH' || code === 'ANCHOR_HEAD_MISMATCH') {
    meaning = `failed: ${reason}`; // anchor codes cannot come from the library here: it is given no anchor
  } else {
    meaning = ENTRY_MEANING[code];
  }
  const keyId = code === 'UNKNOWN_KEY_ID' && rawKeyId !== undefined ? ` (${quoted(rawKeyId, 64)})` : '';
  return result(`The log does NOT verify: ${where} ${meaning}${keyId} (${code}).`, brk, null, anchorChecked);
}
