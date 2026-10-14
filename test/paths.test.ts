import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { isSensitive, resolveInRoot, type PathRule, type Root } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

const CSV: PathRule = { kind: 'file', extensions: ['.csv', '.json'] };
const DIR: PathRule = { kind: 'directory' };

let base: string;
let root: Root;

beforeAll(() => {
  base = tempDir();
  writeTree(base, {
    'project/db/migrations/0001_init.sql': 'create table t (id int);',
    'project/exports/ledger.csv': 'txn,amount\n',
    'project/exports/big.csv': 'x'.repeat(11),
    'project/exports/..odd.csv': 'still inside\n',
    'project/.env': 'SECRET=1\n',
    'project/.git/config': '[core]\n',
    'project/keys/server.pem': 'pem\n',
    'outside/secret.csv': 'a,b\n',
  });
  root = rootOf(path.join(base, 'project'));
});

/** The ErrorCode `fn` throws, or "no error". */
function codeOf(fn: () => unknown): ErrorCode | 'no error' {
  try {
    fn();
    return 'no error';
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.toText();
  }
  throw new Error('expected a ToolError');
}

describe('resolveInRoot', () => {
  it('resolves a file inside the project and reports it relative to the root', () => {
    const r = resolveInRoot(root, 'exports/ledger.csv', CSV);
    expect(r.rel).toBe('exports/ledger.csv');
    expect(r.real).toBe(path.join(root.real, 'exports', 'ledger.csv'));
    expect(r.size).toBe(11);
  });

  it('accepts an absolute path when it is inside the project, and "." for the root folder', () => {
    expect(resolveInRoot(root, path.join(root.real, 'exports', 'ledger.csv'), CSV).rel).toBe('exports/ledger.csv');
    expect(resolveInRoot(root, '.', DIR).rel).toBe('.');
  });

  it('treats a name that merely starts with two dots as an ordinary file', () => {
    expect(resolveInRoot(root, 'exports/..odd.csv', CSV).rel).toBe('exports/..odd.csv');
  });

  it('refuses a path outside the project before touching the disk (no existence oracle)', () => {
    expect(codeOf(() => resolveInRoot(root, '../outside/secret.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, '../outside/does-not-exist.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, path.join(base, 'outside', 'secret.csv'), CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'exports/../../outside/secret.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('refuses empty, over-long, NUL, network and device paths', () => {
    expect(codeOf(() => resolveInRoot(root, '', CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, `${'a/'.repeat(600)}x.csv`, CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, 'exports/ledger.csv\0.csv', CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, '\\\\server\\share\\ledger.csv', CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, '//server/share/ledger.csv', CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, '\\\\?\\C:\\ledger.csv', CSV))).toBe('PATH_INVALID');
    expect(codeOf(() => resolveInRoot(root, '\\\\.\\pipe\\x.csv', CSV))).toBe('PATH_INVALID');
  });

  it.runIf(process.platform === 'win32')('refuses an alternate data stream name on Windows', () => {
    expect(codeOf(() => resolveInRoot(root, 'exports/ledger.csv:hidden', CSV))).toBe('PATH_INVALID');
  });

  it('refuses secret files at any depth, whatever the extension rule and the letter case', () => {
    for (const p of ['.env', '.ENV', 'exports/.env.local', '.git/config', 'keys/server.pem', 'id_rsa', 'deep/id_ed25519.pub', '.npmrc']) {
      expect(codeOf(() => resolveInRoot(root, p, CSV)), p).toBe('SENSITIVE_PATH');
    }
  });

  it('refuses a file type the tool does not read', () => {
    expect(codeOf(() => resolveInRoot(root, 'db/migrations/0001_init.sql', CSV))).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('names the nearest existing folder when a path does not exist', () => {
    expect(codeOf(() => resolveInRoot(root, 'exports/nope.csv', CSV))).toBe('PATH_NOT_FOUND');
    expect(messageOf(() => resolveInRoot(root, 'exports/nope.csv', CSV))).toContain('nearest existing folder is "exports"');
    expect(messageOf(() => resolveInRoot(root, 'db/migratons/x.csv', CSV))).toContain('nearest existing folder is "db"');
    expect(messageOf(() => resolveInRoot(root, 'nowhere/x.csv', CSV))).toContain('nearest existing folder is "."');
  });

  it('never shows the absolute path of the project, only its folder name', () => {
    const text = messageOf(() => resolveInRoot(root, '../outside/secret.csv', CSV));
    expect(text).toContain(`(${root.name})`);
    expect(text).not.toContain(root.real);
  });

  it('checks the kind of entry and the size limit', () => {
    expect(codeOf(() => resolveInRoot(root, 'exports', { kind: 'file' }))).toBe('NOT_A_FILE');
    expect(codeOf(() => resolveInRoot(root, 'exports/ledger.csv', DIR))).toBe('NOT_A_DIRECTORY');
    expect(codeOf(() => resolveInRoot(root, 'exports/big.csv', { ...CSV, maxBytes: 10 }))).toBe('FILE_TOO_LARGE');
    expect(codeOf(() => resolveInRoot(root, 'exports/big.csv', { ...CSV, maxBytes: 11 }))).toBe('no error');
  });

  it('refuses a folder link that leads outside the project', () => {
    // Folder links need no privilege (junctions on Windows), so this half never skips.
    expect(trySymlink(path.join(base, 'outside'), path.join(root.real, 'outdir'), 'dir')).toBe(true);
    expect(codeOf(() => resolveInRoot(root, 'outdir/secret.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'outdir', DIR))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('refuses a file link that leads outside the project', (ctx) => {
    if (!trySymlink(path.join(base, 'outside', 'secret.csv'), path.join(root.real, 'exports', 'out.csv'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(codeOf(() => resolveInRoot(root, 'exports/out.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
  });

  it('refuses an innocent-looking link to a secret file inside the project', (ctx) => {
    if (!trySymlink(path.join(root.real, '.env'), path.join(root.real, 'exports', 'notes.csv'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(codeOf(() => resolveInRoot(root, 'exports/notes.csv', CSV))).toBe('SENSITIVE_PATH');
  });
});

describe('isSensitive', () => {
  it('matches the names in SPEC.md §2.3 and nothing ordinary', () => {
    for (const p of ['.env', '.env.production', 'a/.git/HEAD', 'x.key', 'x.p12', 'x.pfx', 'store.keystore', '.pypirc', '.netrc', '.git-credentials']) {
      expect(isSensitive(p), p).toBe(true);
    }
    for (const p of ['ledger.csv', 'environment.csv', 'db/migrations/0001.sql', 'keys.csv', 'monkey.json', '.github/x.csv']) {
      expect(isSensitive(p), p).toBe(false);
    }
  });
});
