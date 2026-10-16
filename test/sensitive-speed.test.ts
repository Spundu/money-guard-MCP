// The secret-file screen (src/paths.ts isSensitive, SPEC.md §2.3) reads any name in time that grows with
// its length. Review round 17: "logins1-1-1-…-x.csv" made its regex backtrack, ×3 for each "1-": a
// 56-character name, which a repository can ship as an empty file, held the server for hours.
import { describe, expect, it } from 'vitest';
import { isSensitive } from '../src/paths.js';

describe('isSensitive on names that almost match', () => {
  it('answers a near miss of 30 dashes and digits at once', () => {
    for (const name of [`logins${'1-'.repeat(30)}x.csv`, `keystore${'-1'.repeat(30)}x.json`, `logins${' _-'.repeat(30)}x.csv`]) {
      const started = performance.now();
      expect(isSensitive(name), name).toBe(false);
      expect(performance.now() - started, name).toBeLessThan(200);
    }
    // The forms it is for still match.
    expect(['logins-2026-10-16.csv', 'logins_backup.json', 'logins (1).csv', 'keystore-2.json'].map(isSensitive)).toEqual([true, true, true, true]);
  });
});
