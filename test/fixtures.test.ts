// The demo project's audit logs are generated (scripts/fixtures.mts); the committed files must be exactly
// what the generator writes, so nobody "fixes" a fixture by hand.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHOP, auditFixtures } from '../scripts/fixtures.mjs';

describe('fixtures/shop', () => {
  it.each(Object.entries(auditFixtures()))('%s is what scripts/fixtures.mts writes', (rel, content) => {
    expect(readFileSync(path.join(SHOP, rel), 'utf8')).toBe(content);
  });
});
