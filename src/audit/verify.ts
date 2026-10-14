// audit_verify_chain's core (SPEC.md §5): bytes in, result out. No file system, no settings: the
// tool layer reads the file and passes the configured keys.

import { createHash } from 'node:crypto';
import { GENESIS_HASH, jsonlEntryAt, jsonlLineCount, verifyJsonl, type ChainAnchor } from 'sealed-audit-chain';
import type { AuditKeys } from '../config.js';
import { clip } from '../echo.js';

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
  /** sealed-audit-chain's own wording, unchanged. */
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

const NO_ANCHOR_NOTE ='No anchor was given, so entries removed from the end cannot be detected.';
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

export function verifyAuditLog(input: { file: string; bytes: Uint8Array; keys: AuditKeys; anchor?: Anchor | undefined }): AuditResult {
  const { file, bytes, keys, anchor } = input;
  const chainAnchor: ChainAnchor | undefined = anchor ? { count: anchor.count, lastHash: anchor.last_hash } : undefined;
  const verdict = verifyJsonl(bytes, keys.provider, chainAnchor);
  const notes: string[] = [];
  if (bytes.length === 0) notes.push(EMPTY_NOTE);
  if (!anchor) notes.push(NO_ANCHOR_NOTE);
  // The fields in SPEC.md §5.5's order.
  const result = (summary: string, brk: AuditBreak | null, head: Anchor | null): AuditResult => ({
    summary,
    file,
    file_sha256: createHash('sha256').update(bytes).digest('hex'),
    ok: verdict.ok,
    entries_verified: verdict.lastSeq + 1,
    break: brk,
    anchor_checked: anchor !== undefined,
    head,
    key_ids_configured: [...keys.ids],
    notes,
  });

  if (verdict.ok) {
    const count = verdict.lastSeq + 1;
    const last = count === 0 ? GENESIS_HASH : (jsonlEntryAt(bytes, count - 1) as { entry_hash: string }).entry_hash;
    const summary =
      count === 0
        ? 'The log is empty, which always verifies.'
        : `The log verifies: ${entries(count)}, every seal and link intact.` +
          (anchor ? ' It matches the anchor.' : ' Keep head and pass it as anchor next time.');
    return result(summary, null, { count, last_hash: last });
  }

  const index = verdict.brokenAt ?? 0;
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

  let what: string;
  if (code === 'ANCHOR_COUNT_MISMATCH') {
    what = `the log has ${entries(index)} but the anchor says ${anchor?.count ?? '?'}: entries are missing at the end, or were added`;
  } else if (code === 'ANCHOR_HEAD_MISMATCH') {
    what = 'its last entry is not the one the anchor recorded: the log was replaced or rolled back';
  } else {
    const where = line === null ? `entry ${index}` : `entry ${index} (line ${line})`;
    const meaning = code === 'OTHER' ? `failed: ${reason}` : ENTRY_MEANING[code];
    const keyId = code === 'UNKNOWN_KEY_ID' && brk.writer_key_id !== undefined ? ` ("${brk.writer_key_id}")` : '';
    what = `${where} ${meaning}${keyId}`;
  }
  return result(`The log does NOT verify: ${what} (${code}).`, brk, null);
}
