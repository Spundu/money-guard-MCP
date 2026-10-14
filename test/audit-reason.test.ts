// Results repeat sealed-audit-chain's reason. Its fixed reasons are short, but a canonicalization error
// can quote a key name from the log line, so the reason is cut like any other text from the file
// (SPEC.md §5.5). No log makes today's library say that (parseJson builds plain objects), so this file
// stands in a long reason for the library's verdict.
import { describe, expect, it, vi } from 'vitest';
import { verifyAuditLog } from '../src/audit/verify.js';
import { parseAuditKeys } from '../src/config.js';

const fake = vi.hoisted(() => ({ reason: '' }));
vi.mock('sealed-audit-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sealed-audit-chain')>()),
  verifyJsonl: () => ({ ok: false, lastSeq: -1, brokenAt: 0, reason: fake.reason }),
}));

function run() {
  const keys = parseAuditKeys(`k1=${'6b'.repeat(32)}`);
  if (!keys.ok) throw new Error(keys.error.toText());
  return verifyAuditLog({ file: 'logs/audit.jsonl', bytes: Buffer.from('{}\n'), keys: keys.value });
}

describe('a long reason from sealed-audit-chain', () => {
  it('is cut to 120 characters', () => {
    fake.reason = `not canonicalizable: member "${'k'.repeat(300)}" is not a data property`;
    const r = run();
    expect(r.break?.code).toBe('NOT_CANONICALIZABLE');
    expect([...(r.break?.reason ?? '')]).toHaveLength(120);
    expect(r.break?.reason).toMatch(/^not canonicalizable: member "k+…$/);
  });

  it('is cut in the summary too, when it is a reason this version does not know', () => {
    fake.reason = `a new reason ${'z'.repeat(500)}`;
    const r = run();
    expect(r.break?.code).toBe('OTHER');
    expect(r.summary).toBe(`The log does NOT verify: entry 0 (line 1) failed: a new reason ${'z'.repeat(106)}… (OTHER).`);
  });
});
