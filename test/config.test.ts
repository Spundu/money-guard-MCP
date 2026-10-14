import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditKeys, resolveConfig } from '../src/config.js';
import { tempDir, writeTree } from './support/tmp.js';

const KEY_A = '00112233445566778899aabbccddeeff'; // 16 bytes, the minimum
const KEY_B = 'ff'.repeat(32);

function errorText(setting: { ok: boolean; error?: { toText(): string } }): string {
  if (setting.ok || !setting.error) throw new Error('expected an error');
  return setting.error.toText();
}

describe('parseAuditKeys', () => {
  it('reports KEYS_NOT_CONFIGURED when the setting is missing or blank', () => {
    for (const raw of [undefined, '', '   ']) {
      const s = parseAuditKeys(raw);
      expect(s.ok).toBe(false);
      expect(errorText(s)).toMatch(/^KEYS_NOT_CONFIGURED: /);
    }
  });

  it('reads id=hex pairs, with spaces around them, in either letter case', () => {
    const s = parseAuditKeys(` k1=${KEY_A} , 2026-q4 = ${KEY_B.toUpperCase()} `);
    if (!s.ok) throw new Error(s.error.toText());
    expect(s.value.ids).toEqual(['k1', '2026-q4']);
    expect(Buffer.from(s.value.provider.getKey('k1') ?? []).toString('hex')).toBe(KEY_A);
    expect(Buffer.from(s.value.provider.getKey('2026-q4') ?? []).toString('hex')).toBe(KEY_B);
    expect(s.value.provider.getKey('k3')).toBeNull();
  });

  it('treats an id such as "__proto__" as an ordinary id', () => {
    const s = parseAuditKeys(`__proto__=${KEY_A}`);
    if (!s.ok) throw new Error(s.error.toText());
    expect(s.value.ids).toEqual(['__proto__']);
    expect(s.value.provider.getKey('__proto__')).not.toBeNull();
  });

  it('refuses malformed settings and names the pair, never the key', () => {
    const cases: Array<[string, RegExp]> = [
      [`k1${KEY_A}`, /pair 1 has no "="/],
      [`k1=${KEY_A},,k2=${KEY_B}`, /pair 2 is empty/],
      [`=${KEY_A}`, /pair 1 has an id that is empty/],
      [`my key=${KEY_A}`, /pair 1 has an id that is empty, longer than 64 characters or contains spaces/],
      [`${'k'.repeat(65)}=${KEY_A}`, /pair 1 has an id/],
      [`k1=${KEY_A},k1=${KEY_B}`, /pair 2 \("k1"\) repeats an id/],
      [`k1=${KEY_A}0`, /not an even number of hex digits/],
      [`k1=${KEY_A.slice(0, -2)}zz`, /not an even number of hex digits/],
      [`k1=${KEY_A.slice(0, -2)}`, /shorter than 16 bytes/],
    ];
    for (const [raw, expected] of cases) {
      const text = errorText(parseAuditKeys(raw));
      expect(text, raw).toMatch(/^KEYS_INVALID: /);
      expect(text, raw).toMatch(expected);
      expect(text, raw).not.toContain(KEY_A.slice(0, 8));
      expect(text, raw).not.toContain(KEY_B.slice(0, 8));
    }
  });

  it('takes at most 64 pairs, so the list of ids in every audit result stays small', () => {
    const ring = (n: number) => Array.from({ length: n }, (_, i) => `k${i}=${KEY_A}`).join(',');
    const ok = parseAuditKeys(ring(64));
    expect(ok.ok && ok.value.ids.length).toBe(64);
    expect(errorText(parseAuditKeys(ring(65)))).toMatch(/^KEYS_INVALID: MONEY_GUARD_AUDIT_KEYS is malformed: it has 65 pairs; at most 64 are allowed\./);
  });
});

describe('resolveConfig root', () => {
  it('uses MONEY_GUARD_ROOT first, then CLAUDE_PROJECT_DIR, then the working directory', () => {
    const a = tempDir();
    const b = tempDir();
    const c = tempDir();
    expect(resolveConfig({ MONEY_GUARD_ROOT: a, CLAUDE_PROJECT_DIR: b }, c).root).toEqual({
      ok: true,
      value: { real: a, name: path.basename(a) },
    });
    expect(resolveConfig({ CLAUDE_PROJECT_DIR: b }, c).root).toMatchObject({ ok: true, value: { real: b } });
    expect(resolveConfig({ MONEY_GUARD_ROOT: '  ' }, c).root).toMatchObject({ ok: true, value: { real: c } });
  });

  it('refuses a missing folder, a file and a disk root, without showing the path', () => {
    const dir = tempDir();
    writeTree(dir, { 'file.txt': 'x' });
    const missing = resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'nope') }, dir).root;
    expect(errorText(missing)).toMatch(/^ROOT_INVALID: The project root \(from MONEY_GUARD_ROOT\) does not exist\./);
    expect(errorText(missing)).not.toContain(dir);
    expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'file.txt') }, dir).root)).toMatch(/is not a folder/);
    expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: path.parse(dir).root }, dir).root)).toMatch(/is the root of a disk/);
  });

  it('resolves a relative MONEY_GUARD_ROOT against the working directory', () => {
    const dir = tempDir();
    writeTree(dir, { 'app/x.sql': '' });
    expect(resolveConfig({ MONEY_GUARD_ROOT: 'app' }, dir).root).toMatchObject({ ok: true, value: { real: path.join(dir, 'app'), name: 'app' } });
  });
});
