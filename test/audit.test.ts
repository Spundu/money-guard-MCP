import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GENESIS_HASH, InMemoryKeyProvider, appendEntry, toJsonlLine, type SealedEntry } from 'sealed-audit-chain';
import { describe, expect, it } from 'vitest';
import { reasonCode, verifyAuditLog, type Anchor, type ReasonCode } from '../src/audit/verify.js';
import { parseAuditKeys, type AuditKeys } from '../src/config.js';

const KEY_HEX = '6b'.repeat(32);
const OTHER_HEX = '7c'.repeat(32);

function keysFrom(raw: string): AuditKeys {
  const setting = parseAuditKeys(raw);
  if (!setting.ok) throw new Error(setting.error.toText());
  return setting.value;
}
const KEYS = keysFrom(`k1=${KEY_HEX}`);

const DRAFTS = [
  { event: 'user.login', user: 'alice' },
  { event: 'payment.refund', user: 'alice', amount_pence: 1900 },
  { event: 'user.logout', user: 'alice' },
];

/** A chain sealed with `keyId` = `keyHex`, as sealed-audit-chain's writer would seal it. */
function chain(drafts: object[] = DRAFTS, keyId = 'k1', keyHex = KEY_HEX): SealedEntry[] {
  const provider = new InMemoryKeyProvider({ [keyId]: Buffer.from(keyHex, 'hex') }, keyId);
  const out: SealedEntry[] = [];
  let prev: SealedEntry | null = null;
  for (const draft of drafts) {
    prev = appendEntry(prev, draft as Record<string, unknown>, provider);
    out.push(prev);
  }
  return out;
}

const text = (entries: SealedEntry[]) => entries.map((e) => toJsonlLine(e)).join('');
const bytes = (s: string) => Buffer.from(s, 'utf8');
const run = (b: Uint8Array, anchor?: Anchor, keys: AuditKeys = KEYS) =>
  verifyAuditLog({ file: 'logs/audit.jsonl', bytes: b, keys, anchor });

const VALID = text(chain());
const LINES = VALID.split('\n').slice(0, -1);
const HEAD: Anchor = { count: 3, last_hash: (chain()[2] as SealedEntry).entry_hash };

describe('verifyAuditLog on a log that verifies', () => {
  it('returns the head to keep as the next anchor, and warns that no anchor was checked', () => {
    const r = run(bytes(VALID));
    expect(r).toEqual({
      summary: 'The log verifies: 3 entries, every seal and link intact. Keep head and pass it as anchor next time.',
      file: 'logs/audit.jsonl',
      file_sha256: createHash('sha256').update(VALID).digest('hex'),
      ok: true,
      entries_verified: 3,
      break: null,
      anchor_checked: false,
      head: HEAD,
      key_ids_configured: ['k1'],
      notes: ['No anchor was given, so entries removed from the end cannot be detected.'],
    });
  });

  it('checks a matching anchor', () => {
    const r = run(bytes(VALID), HEAD);
    expect(r.ok).toBe(true);
    expect(r.anchor_checked).toBe(true);
    expect(r.notes).toEqual([]);
    expect(r.summary).toBe('The log verifies: 3 entries, every seal and link intact. It matches the anchor.');
  });

  it('says plainly that an empty log proves nothing', () => {
    const r = run(new Uint8Array());
    expect(r.ok).toBe(true);
    expect(r.entries_verified).toBe(0);
    expect(r.head).toEqual({ count: 0, last_hash: GENESIS_HASH });
    expect(r.summary).toBe('The log is empty, which always verifies.');
    expect(r.notes[0]).toMatch(/^The log is empty\. An empty log always verifies; pass an anchor/);
  });
});

/** Each case breaks the log one way; every reason verifyJsonl can return is here. */
const BROKEN: Array<{ name: string; log: () => Uint8Array; anchor?: Anchor; code: ReasonCode; index: number; line: number | null }> = [
  { name: 'an edited entry', log: () => bytes(VALID.replace('"alice"', '"mallory"')), code: 'CONTENT_TAMPERED', index: 0, line: 1 },
  { name: 'a cut-off last line', log: () => bytes(VALID.slice(0, -1)), code: 'TORN_LAST_LINE', index: 2, line: 3 },
  { name: 'a line too large to be an entry', log: () => bytes(`${VALID}${'x'.repeat(1024 * 1024 + 1)}\n`), code: 'LINE_TOO_LARGE', index: 3, line: 4 },
  { name: 'a line that is not UTF-8', log: () => Buffer.concat([bytes(VALID), Buffer.from([0xff, 0x0a])]), code: 'NOT_UTF8', index: 3, line: 4 },
  { name: 'a line that is not JSON', log: () => bytes(`${VALID}not json\n`), code: 'NOT_JSON', index: 3, line: 4 },
  { name: 'a rewritten line', log: () => bytes([LINES[0], (LINES[1] ?? '').replace(',', ', '), LINES[2], ''].join('\n')), code: 'NOT_CANONICAL', index: 1, line: 2 },
  { name: 'a float', log: () => bytes(`${VALID}{"a":1.5}\n`), code: 'OUTSIDE_CANONICAL_DOMAIN', index: 3, line: 4 },
  { name: 'a line that is not an object', log: () => bytes(`${VALID}[]\n`), code: 'NOT_AN_OBJECT', index: 3, line: 4 },
  { name: 'two entries swapped', log: () => bytes([LINES[1], LINES[0], LINES[2], ''].join('\n')), code: 'SEQ_MISMATCH', index: 0, line: 1 },
  {
    name: 'an entry from another chain',
    log: () => {
      const other = chain([{ event: 'something.else' }, ...DRAFTS.slice(1)]);
      return bytes(text([chain()[0] as SealedEntry, other[1] as SealedEntry]));
    },
    code: 'LINK_BROKEN',
    index: 1,
    line: 2,
  },
  { name: 'a key id nobody configured', log: () => bytes(text(chain(DRAFTS, 'k2'))), code: 'UNKNOWN_KEY_ID', index: 0, line: 1 },
  { name: 'a forged seal', log: () => bytes(text(chain(DRAFTS, 'k1', OTHER_HEX))), code: 'HMAC_MISMATCH', index: 0, line: 1 },
  { name: 'entries cut from the end', log: () => bytes(VALID), anchor: { ...HEAD, count: 4 }, code: 'ANCHOR_COUNT_MISMATCH', index: 3, line: null },
  { name: 'a replaced log', log: () => bytes(VALID), anchor: { ...HEAD, last_hash: '0'.repeat(64) }, code: 'ANCHOR_HEAD_MISMATCH', index: 2, line: 3 },
];

describe('verifyAuditLog on a broken log', () => {
  for (const c of BROKEN) {
    it(`reports ${c.code} for ${c.name}`, () => {
      const r = run(c.log(), c.anchor);
      expect(r.ok).toBe(false);
      expect(r.head).toBeNull();
      expect(r.break).toMatchObject({ entry_index: c.index, line: c.line, code: c.code });
      expect(r.entries_verified).toBe(c.index);
      expect(r.summary).toMatch(new RegExp(`^The log does NOT verify: .*\\(${c.code}\\)\\.$`));
    });
  }

  it('words the summary as SPEC.md §5.8 shows', () => {
    const r = run(bytes(VALID.replace('"alice"', '"mallory"')));
    expect(r.summary).toBe('The log does NOT verify: entry 0 (line 1) was edited after it was sealed (CONTENT_TAMPERED).');
    expect(r.break?.reason).toBe('entry_hash mismatch (content tampered)');
  });

  it('names the key id an entry was sealed with, for a missing or wrong key', () => {
    const unknown = run(bytes(text(chain(DRAFTS, 'k2'))));
    expect(unknown.break?.writer_key_id).toBe('k2');
    expect(unknown.summary).toContain('names a key id that is not configured ("k2")');
    expect(run(bytes(text(chain(DRAFTS, 'k1', OTHER_HEX)))).break?.writer_key_id).toBe('k1');
    const long = 'k'.repeat(100);
    expect([...(run(bytes(text(chain(DRAFTS, long)))).break?.writer_key_id ?? '')].length).toBe(64);
  });

  it('describes a cut tail with both counts', () => {
    expect(run(bytes(VALID), { ...HEAD, count: 5 }).summary).toBe(
      'The log does NOT verify: the log has 3 entries but the anchor says 5: entries are missing at the end, or were added (ANCHOR_COUNT_MISMATCH).',
    );
  });

  it('never puts a key into a result', () => {
    for (const c of BROKEN) {
      const json = JSON.stringify(run(c.log(), c.anchor));
      expect(json).not.toContain(KEY_HEX.slice(0, 16));
      expect(json).not.toContain(OTHER_HEX.slice(0, 16));
    }
  });
});

describe('reasonCode', () => {
  // sealed-audit-chain's reasons, read from its own source: a reason added there and not mapped here
  // fails this test instead of silently becoming OTHER.
  const require = createRequire(import.meta.url);
  const pkgDir = path.dirname(require.resolve('sealed-audit-chain/package.json'));
  const source = ['verify.ts', 'jsonl.ts'].map((f) => readFileSync(path.join(pkgDir, 'src', f), 'utf8')).join('\n');
  const literal = String.raw`(?:'([^']+)'|` + '`([^`]+)`)';
  const patterns = [new RegExp(String.raw`(?:error|unreadable): ` + literal, 'g'), new RegExp(String.raw`broken\([^,]+, ` + literal, 'g')];
  const reasons = new Set<string>();
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) reasons.add((m[1] ?? m[2] ?? '').replace(/\$\{[^}]+\}/g, '7'));
  }
  // Reachable only through verifyChain on in-memory values (getters, proxies, a non-array), never
  // through verifyJsonl, which is all this tool calls.
  const VERIFY_CHAIN_ONLY = new Set(['entries is not an array', 'entries cannot be read', 'entry cannot be read']);

  it('finds the library reasons (the scan is not vacuous)', () => {
    expect(reasons.size).toBeGreaterThanOrEqual(15);
  });

  it('maps every reason verifyJsonl can return to its own code', () => {
    const unmapped = [...reasons].filter((r) => !VERIFY_CHAIN_ONLY.has(r) && reasonCode(r) === 'OTHER');
    expect(unmapped).toEqual([]);
  });

  it('maps the patterned reasons whatever their numbers, and anything unknown to OTHER', () => {
    expect(reasonCode('seq mismatch: expected 12345')).toBe('SEQ_MISMATCH');
    expect(reasonCode('count 0 != anchor count (truncation)')).toBe('ANCHOR_COUNT_MISMATCH');
    expect(reasonCode('not canonicalizable: depth > 100')).toBe('NOT_CANONICALIZABLE');
    expect(reasonCode('a reason from a future version')).toBe('OTHER');
    expect(reasonCode('toString')).toBe('OTHER');
  });
});
