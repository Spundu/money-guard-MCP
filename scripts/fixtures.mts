// The audit logs of the demo project in fixtures/shop, sealed with a TEST key that is published on
// purpose (FIXTURE_KEY_HEX; never use it for anything real). Run `node scripts/fixtures.mts` (Node.js
// 22.18 or newer runs TypeScript directly) to rewrite them; test/fixtures.test.ts fails if the committed
// files differ from what this produces.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryKeyProvider, appendEntry, toJsonlLine, type SealedEntry } from 'sealed-audit-chain';

/** 32 bytes of 0x6b: the fixture key for key id k1. A test key, public on purpose. */
export const FIXTURE_KEY_HEX = '6b'.repeat(32);

export const SHOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shop');

/** File (relative to fixtures/shop) → content. */
export function auditFixtures(): Record<string, string> {
  const keys = new InMemoryKeyProvider({ k1: Buffer.from(FIXTURE_KEY_HEX, 'hex') }, 'k1');
  const entries: SealedEntry[] = [];
  let prev: SealedEntry | null = null;
  for (const draft of [
    { event: 'user.login', user: 'alice' },
    { event: 'payment.refund', user: 'alice', amount_pence: 1900 },
  ]) {
    prev = appendEntry(prev, draft, keys);
    entries.push(prev);
  }
  const log = entries.map((e) => toJsonlLine(e)).join('');
  return {
    'logs/audit.jsonl': log,
    // Someone changed "alice" to "mallory" in the first entry after it was sealed.
    'logs/audit-tampered.jsonl': log.replace('"user":"alice"', '"user":"mallory"'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [rel, content] of Object.entries(auditFixtures())) writeFileSync(path.join(SHOP, rel), content);
  console.log('fixtures/shop/logs written');
}
