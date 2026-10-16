// A log is read once (SPEC.md §5.7), one with its last LF missing too. Review round 14: the check that
// only the LF is missing read a 100 MiB log a second time, 8 s instead of 4. And what that one read
// gives for the last line: torn only when it does not read as an entry (§5.4, review round 15).
import { appendEntry, InMemoryKeyProvider, toJsonlLine, type SealedEntry } from 'sealed-audit-chain';
import { describe, expect, it, vi } from 'vitest';
import { verifyAuditLog } from '../src/audit/verify.js';
import { parseAuditKeys } from '../src/config.js';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('sealed-audit-chain', async (importOriginal) => {
  const real = await importOriginal<typeof import('sealed-audit-chain')>();
  return { ...real, verifyJsonl: (...args: Parameters<typeof real.verifyJsonl>) => ((calls.n += 1), real.verifyJsonl(...args)) };
});

const KEY_HEX = '6b'.repeat(32);

function sealed(): string {
  const provider = new InMemoryKeyProvider({ k1: Buffer.from(KEY_HEX, 'hex') }, 'k1');
  let prev: SealedEntry | null = null;
  let out = '';
  for (const user of ['alice', 'bob', 'carol']) {
    prev = appendEntry(prev, { event: 'user.login', user }, provider);
    out += toJsonlLine(prev);
  }
  return out;
}

describe('audit_verify_chain reads a log once', () => {
  it.each([
    ['whole', (s: string) => s, true],
    ['without its last LF', (s: string) => s.slice(0, -1), false],
    ['cut inside its last line', (s: string) => s.slice(0, -10), false],
  ])('%s', (_name, change, ok) => {
    const keys = parseAuditKeys(`k1=${KEY_HEX}`);
    if (!keys.ok) throw new Error(keys.error.toText());
    calls.n = 0;
    const r = verifyAuditLog({ file: 'logs/audit.jsonl', bytes: Buffer.from(change(sealed())), keys: keys.value });
    expect([r.ok, calls.n]).toEqual([ok, 1]);
  });

  it('keeps an earlier break when the last LF is missing too', () => {
    const keys = parseAuditKeys(`k1=${KEY_HEX}`);
    if (!keys.ok) throw new Error(keys.error.toText());
    const r = verifyAuditLog({ file: 'logs/audit.jsonl', bytes: Buffer.from(sealed().replace('"bob"', '"eve"').slice(0, -1)), keys: keys.value });
    expect([r.break?.code, r.break?.entry_index]).toEqual(['CONTENT_TAMPERED', 1]);
  });

  it('reports an edited last entry as edited when its LF is missing too, not as an interrupted write', () => {
    // Review round 15: the edit read as "cut off ... an interrupted write", and deleting the line hides it.
    const keys = parseAuditKeys(`k1=${KEY_HEX}`);
    if (!keys.ok) throw new Error(keys.error.toText());
    const r = verifyAuditLog({ file: 'logs/audit.jsonl', bytes: Buffer.from(sealed().replace('"carol"', '"eve"').slice(0, -1)), keys: keys.value });
    expect([r.break?.code, r.break?.entry_index, calls.n > 0]).toEqual(['CONTENT_TAMPERED', 2, true]);
    expect(r.notes).toContain('The last line also lacks its line end (LF); the entry on it is whole, so it was checked as it stands.');
  });
});
