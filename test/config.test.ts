// The server's settings (src/config.ts, SPEC.md §2.2): the key ring, which never echoes key material,
// and the project root, which must exist, be a folder, not be a disk root, and be its real path.
import { chmodSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { parseAuditKeys, resolveConfig } from '../src/config.js';
import { checkLedgerFile } from '../src/ledger/run.js';
import { tempDir, trySymlink, writeTree } from './support/tmp.js';

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

  it('reports KEYS_NOT_CONFIGURED, naming the variable, for a placeholder the MCP host did not fill in', () => {
    // Claude Code leaves ${VAR} as it is when VAR is not set; Claude Desktop does the same for an
    // optional setting without a value.
    const cases: Array<[string, string]> = [
      ['${MONEY_GUARD_AUDIT_KEYS}', 'the placeholder for MONEY_GUARD_AUDIT_KEYS'],
      ['${MONEY_GUARD_AUDIT_KEYS:-}', 'the placeholder for MONEY_GUARD_AUDIT_KEYS'],
      [' ${user_config.audit_keys} ', 'the placeholder for user_config.audit_keys'],
    ];
    for (const [raw, which] of cases) {
      expect(errorText(parseAuditKeys(raw))).toMatch(new RegExp(`^KEYS_NOT_CONFIGURED: MONEY_GUARD_AUDIT_KEYS holds ${which}, which the MCP host did not fill in`));
    }
    // A value that only starts with a placeholder was set to something: it is malformed, not missing.
    expect(errorText(parseAuditKeys('${MONEY_GUARD_AUDIT_KEYS}k2=00'))).toMatch(/^KEYS_INVALID: /);
  });

  it('never repeats key material from a malformed setting or placeholder', () => {
    // A key written where the id belongs, a key with a stray "=", a base64 key pasted without an id
    // (base64 ends in "="), and keys inside placeholders.
    const BASE64 = Buffer.from(KEY_B, 'hex').toString('base64');
    for (const raw of [`${KEY_B}=`, `${KEY_B}=k1`, `k1=${KEY_A},${KEY_B}=${KEY_B}0`, BASE64, `\${MONEY_GUARD_AUDIT_KEYS:-k1=${KEY_B}}`, `\${k1=${KEY_B}}`]) {
      const text = errorText(parseAuditKeys(raw));
      for (const secret of [KEY_A.slice(0, 8), KEY_B.slice(0, 8), BASE64.slice(0, 8)]) expect(text, raw).not.toContain(secret);
    }
    // Review round 19: a placeholder whose name is a key is not named.
    expect(errorText(parseAuditKeys(`\${${'ab'.repeat(32)}}`))).not.toContain('abababab');
    // Round 20: nor one of 32 hex digits, the shortest key; 31 are not a key, and are named.
    expect(errorText(parseAuditKeys(`\${${'ab'.repeat(16)}}`))).not.toContain('abababab');
    expect(errorText(parseAuditKeys(`\${${'ab'.repeat(15)}a}`))).toContain(`the placeholder for ${'ab'.repeat(15)}a`);
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
      [`k1=${KEY_A},k1=${KEY_B}`, /pair 2 repeats the id of pair 1/],
      [`${KEY_B}=${KEY_A}`, /pair 1 has an id that looks like a key \(32 or more hex digits\)/],
      [`${KEY_A}=${KEY_B}`, /pair 1 has an id that looks like a key \(32 or more hex digits\)/], // the shortest key
      [`k1\u{200b}=${KEY_A}`, /pair 1 has an id with a control or invisible character/],
      [`k1=${KEY_A}0`, /has a key with an odd number of hex digits/],
      [`k1=${KEY_A.slice(0, -2)}zz`, /not hex digits only \(0-9, a-f; no 0x; pairs separated by commas\)/], // round 21: said apart
      [`k1=${KEY_A};k2=${KEY_B}`, /pair 1 has a key that is not hex digits only/],
      [`k1=0x${KEY_A}`, /pair 1 has a key that is not hex digits only/],
      [`k1=${KEY_A.slice(0, -2)}`, /shorter than 16 bytes/],
    ];
    for (const [raw, expected] of cases) {
      const text = errorText(parseAuditKeys(raw));
      expect(text, raw).toMatch(/^KEYS_INVALID: /);
      expect(text, raw).toMatch(expected);
      expect(text, raw).not.toContain(KEY_A.slice(0, 8));
      expect(text, raw).not.toContain(KEY_B.slice(0, 8));
    }
    // 31 hex digits are too few for a key (16 bytes): an ordinary id.
    expect(parseAuditKeys(`${KEY_A.slice(0, 31)}=${KEY_B}`).ok).toBe(true);
  });

  it('takes at most 64 pairs, so the list of ids in every audit result stays small', () => {
    const ring = (n: number) => Array.from({ length: n }, (_, i) => `k${i}=${KEY_A}`).join(',');
    const ok = parseAuditKeys(ring(64));
    expect(ok.ok && ok.value.ids.length).toBe(64);
    expect(errorText(parseAuditKeys(ring(65)))).toMatch(/^KEYS_INVALID: MONEY_GUARD_AUDIT_KEYS is malformed: it has 65 pairs; at most 64 are allowed\./);
  });

  it('says to remove quotes kept around the value, and shows none of it', () => {
    // Review round 17: "'k1=<hex>'" was "a key that is not an even number of hex digits".
    for (const raw of [`'k1=${KEY_A}'`, `"k1=${KEY_A}"`, ` 'k1=${KEY_A}`, `k1=${KEY_A}'`]) { // a quote at one end only, too
      const text = errorText(parseAuditKeys(raw));
      expect(text, raw).toMatch(/^KEYS_INVALID: .* Fix: Remove the quotes around the value/);
      expect(text).not.toContain(KEY_A);
    }
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

  it('says when the quotes around the folder were kept, not that it does not exist', () => {
    // Review round 21: "C:\...\shop" with its quotes was "does not exist".
    const dir = tempDir();
    for (const value of [`"${dir}"`, `'${dir}'`]) {
      const root = resolveConfig({ MONEY_GUARD_ROOT: value }, dir).root;
      expect(root.ok ? 'ok' : root.error.message).toBe('The project root (from MONEY_GUARD_ROOT) starts or ends with a quote mark: the quotes around the value were kept as part of it; remove them.');
    }
    // Round 22: but a folder whose name ends in an apostrophe is a folder, from the setting or not.
    const students = path.join(dir, "Students'");
    writeTree(students, { 'keep.txt': '' });
    for (const env of [{ MONEY_GUARD_ROOT: students }, { CLAUDE_PROJECT_DIR: students }, {}]) {
      expect(resolveConfig(env, students).root.ok, JSON.stringify(env)).toBe(true);
    }
  });

  it('says that ~, $VAR, %VAR% and file: are not expanded in the setting', () => {
    // Review round 22: each was a bare "does not exist".
    const dir = tempDir();
    for (const value of ['~/proj', '$HOME/proj', '${HOME}/proj', '%USERPROFILE%\\proj', 'file:///C:/x']) {
      const root = resolveConfig({ MONEY_GUARD_ROOT: value }, dir).root;
      expect(root.ok ? 'ok' : root.error.message, value).toBe('The project root (from MONEY_GUARD_ROOT) does not exist: ~, $VAR, %VAR% and file: are not expanded in this setting; give an absolute path.');
    }
    expect(resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'nope') }, dir).root).toMatchObject({ ok: false, error: { message: 'The project root (from MONEY_GUARD_ROOT) does not exist.' } });
  });

  it('refuses a missing folder, a file and a disk root, without showing the path', () => {
    const dir = tempDir();
    writeTree(dir, { 'file.txt': 'x' });
    const missing = resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'nope') }, dir).root;
    expect(errorText(missing)).toMatch(/^ROOT_INVALID: The project root \(from MONEY_GUARD_ROOT\) does not exist\./);
    expect(errorText(missing)).not.toContain(dir);
    expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'file.txt') }, dir).root)).toMatch(/is not a folder/);
    expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: path.parse(dir).root }, dir).root)).toMatch(/is the root of a disk/);
    // Review round 10: "C:" is the current folder of drive C on Windows, not a folder of its own.
    for (const drive of ['C:', 'd:project', 'C:.']) {
      expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: drive }, dir).root), drive).toMatch(/^ROOT_INVALID: .* a drive letter without a backslash after it/);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says a root it may not open cannot be opened, not that it does not exist (POSIX)', () => {
    const dir = tempDir();
    writeTree(dir, { 'shut/project/x.csv': 'x' });
    chmodSync(path.join(dir, 'shut'), 0o000);
    try {
      const shut = resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'shut', 'project') }, dir).root;
      expect(errorText(shut)).toMatch(/^ROOT_INVALID: The project root \(from MONEY_GUARD_ROOT\) cannot be opened \(permission denied\)\./);
    } finally {
      chmodSync(path.join(dir, 'shut'), 0o700);
    }
    // The project folder itself locked: it resolves, but cannot be listed or entered.
    writeTree(dir, { 'own/x.csv': 'x' });
    chmodSync(path.join(dir, 'own'), 0o000);
    try {
      const own = resolveConfig({ MONEY_GUARD_ROOT: path.join(dir, 'own') }, dir).root;
      expect(errorText(own)).toMatch(/^ROOT_INVALID: The project root \(from MONEY_GUARD_ROOT\) cannot be opened \(permission denied\)\./);
    } finally {
      chmodSync(path.join(dir, 'own'), 0o700);
    }
  });

  it('refuses a root that is still a placeholder, instead of falling back to another folder', () => {
    const dir = tempDir();
    expect(errorText(resolveConfig({ MONEY_GUARD_ROOT: '${user_config.project_folder}', CLAUDE_PROJECT_DIR: dir }, dir).root)).toMatch(
      /^ROOT_INVALID: The project root \(from MONEY_GUARD_ROOT\) is "\$\{user_config\.project_folder\}", a placeholder the MCP host did not fill in\./,
    );
  });

  it('resolves the root to its real path, so a project opened through a link can read its own files', () => {
    const real = tempDir();
    writeTree(real, { 'exports/l.csv': 't,a\nA,1\nA,-1\n' });
    const link = path.join(tempDir(), 'linked-project');
    expect(trySymlink(real, link, 'dir')).toBe(true); // a junction on Windows: no privilege needed
    const root = resolveConfig({ MONEY_GUARD_ROOT: link }, real).root;
    if (!root.ok) throw new Error(root.error.toText());
    expect(root.value).toEqual({ real, name: path.basename(real) });
    expect(checkLedgerFile(root.value, { file: 'exports/l.csv', columns: { transaction_id: 't', amount: 'a' } }).balanced).toBe(true);
  });

  it('resolves a relative MONEY_GUARD_ROOT against the working directory', () => {
    const dir = tempDir();
    writeTree(dir, { 'app/x.sql': '' });
    expect(resolveConfig({ MONEY_GUARD_ROOT: 'app' }, dir).root).toMatchObject({ ok: true, value: { real: path.join(dir, 'app'), name: 'app' } });
  });
});
