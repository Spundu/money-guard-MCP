// Which files the tools may read (src/paths.ts, SPEC.md §2.3): confinement to the project, secret files,
// file types, sizes, links, and a file that passes the checks but cannot be read.
import { chmodSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { checkLedgerFile } from '../src/ledger/run.js';
import { collectSources } from '../src/lint/files.js';
import { isSensitive, readChecked, resolveInRoot, type PathRule, type Root } from '../src/paths.js';
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
    'project/..top.csv': 'at the root, still inside\n',
    'project/notes.txt': 'not a ledger\n',
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
    expect(resolveInRoot(root, '..top.csv', CSV).rel).toBe('..top.csv');
  });

  it('refuses a path outside the project before touching the disk (no existence oracle)', () => {
    expect(codeOf(() => resolveInRoot(root, '../outside/secret.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, '../outside/does-not-exist.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, path.join(base, 'outside', 'secret.csv'), CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'exports/../../outside/secret.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    // The parent folder itself, as a folder argument (migrations: ".."), is outside too.
    for (const parent of ['..', '../', 'exports/../..', path.dirname(root.real)]) {
      expect(codeOf(() => resolveInRoot(root, parent, DIR)), parent).toBe('PATH_OUTSIDE_ROOT');
    }
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

  it('gives the exact size of a file just over the limit, which a rounded size would hide', () => {
    const limit = 25 * 1024 * 1024;
    writeTree(root.real, { 'exports/huge.csv': Buffer.alloc(limit + 1, 0x41) });
    expect(messageOf(() => resolveInRoot(root, 'exports/huge.csv', { ...CSV, maxBytes: limit }))).toMatch(
      /^FILE_TOO_LARGE: "exports\/huge\.csv" is 25 MiB \(26,214,401 bytes\); this tool reads at most 25 MiB\./,
    );
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

describe('resolveInRoot and links to the wrong kind of file', () => {
  it('refuses a link with an allowed name to a file of another type (POSIX, or Windows with Developer Mode)', (ctx) => {
    if (!trySymlink(path.join(root.real, 'notes.txt'), path.join(root.real, 'exports', 'looks-fine.csv'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(codeOf(() => resolveInRoot(root, 'exports/looks-fine.csv', CSV))).toBe('FILE_TYPE_NOT_ALLOWED');
  });
});

describe('readChecked', () => {
  it('turns a read that fails after the checks into FILE_UNREADABLE, saying why, not a crash', () => {
    // A folder cannot be read as a file (EISDIR) on every platform: the same path as a locked file.
    const err = (() => {
      try {
        readChecked(path.join(root.real, 'exports'), 'exports');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toText()).toBe('FILE_UNREADABLE: "exports" cannot be read (EISDIR). Fix: Close the program that holds it, or fix its permissions, then call again.');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says "permission denied" for a file or folder nobody may read, in every tool (POSIX; root reads anything)', () => {
    writeTree(root.real, { 'exports/locked.csv': 't,a\n', 'locked/db/0001.sql': 'select 1;', 'locked/db/inner/0002.sql': 'select 1;' });
    const file = path.join(root.real, 'exports', 'locked.csv');
    const folder = path.join(root.real, 'locked', 'db', 'inner');
    chmodSync(file, 0o000);
    chmodSync(folder, 0o000);
    try {
      expect(() => readChecked(file, 'exports/locked.csv')).toThrow(/^"exports\/locked\.csv" cannot be read \(permission denied\)\.$/);
      expect(codeOf(() => checkLedgerFile(root, { file: 'exports/locked.csv', columns: { transaction_id: 't', amount: 'a' } }))).toBe('FILE_UNREADABLE');
      expect(codeOf(() => collectSources(root, { migrations: 'locked/db' }))).toBe('FILE_UNREADABLE');
    } finally {
      chmodSync(file, 0o600);
      chmodSync(folder, 0o700);
    }
  });
});

describe('a path through a folder nobody may open', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('says "permission denied", not "does not exist" or a crash, wherever the path comes from (POSIX)', () => {
    writeTree(root.real, { 'shut/ledger.csv': 't,a\n', 'shut/0002.sql': 'select 2;', 'listed/0001.sql': 'select 1;', 'linked/0001.sql': 'select 1;' });
    symlinkSync(path.join(root.real, 'shut', '0002.sql'), path.join(root.real, 'linked', '0002.sql'));
    const shut = path.join(root.real, 'shut');
    const listed = path.join(root.real, 'listed');
    chmodSync(shut, 0o000); // nothing in it can be listed or opened
    chmodSync(listed, 0o444); // its names can be listed, but nothing in it opened
    const textOf = (fn: () => unknown): string => {
      try {
        fn();
        return 'no error';
      } catch (err) {
        return err instanceof ToolError ? err.toText() : String(err);
      }
    };
    try {
      // a path argument
      expect(textOf(() => resolveInRoot(root, 'shut/ledger.csv', CSV))).toMatch(/^FILE_UNREADABLE: "shut\/ledger\.csv" cannot be read \(permission denied\)\./);
      // a migration found in a folder, or named in files
      expect(textOf(() => collectSources(root, { migrations: 'listed' }))).toMatch(/^FILE_UNREADABLE: "listed(?:\/0001\.sql)?" cannot be read \(permission denied\)\./);
      expect(textOf(() => collectSources(root, { migrations: 'listed', files: ['0001.sql'] }))).toMatch(/^FILE_UNREADABLE: "listed\/0001\.sql" cannot be read \(permission denied\)\./);
      // a link in a migrations folder
      expect(textOf(() => collectSources(root, { migrations: 'linked' }))).toMatch(/^FILE_UNREADABLE: "linked\/0002\.sql" cannot be read \(permission denied\)\./);
    } finally {
      chmodSync(shut, 0o700);
      chmodSync(listed, 0o700);
    }
  });
});

describe('isSensitive', () => {
  it('matches the names in SPEC.md §2.3 and nothing ordinary', () => {
    for (const p of ['.env', '.env.production', 'a/.git/HEAD', 'x.key', 'x.p12', 'x.pfx', 'store.keystore', '.pypirc', '.netrc', '.git-credentials',
      'credentials.csv', 'exports/credentials.json', 'secrets.json', 'alice_accessKeys.csv', 'rootkey.csv', 'client_secret_123.apps.json', 'my-project-service-account.json',
      // review round 4: AWS console sign-in, Firebase and Google Cloud key downloads, OAuth tokens
      'alice_credentials.csv', 'application_default_credentials.json', 'serviceAccountKey.json', 'myapp-firebase-adminsdk-x1y2z-0123456789.json',
      'my-project-1a2b3c4d5e6f.json', 'token.json']) {
      expect(isSensitive(p), p).toBe(true);
    }
    for (const p of ['ledger.csv', 'environment.csv', 'db/migrations/0001.sql', 'keys.csv', 'monkey.json', '.github/x.csv', 'credit_notes.csv', 'secretary.csv', 'accessories.csv',
      // credential words in a migration or a folder name: not a credential download
      'db/migrations/0002_create_access_keys.sql', 'db/migrations/0003_client_secrets.sql', 'db/migrations/20240202_add_service_accounts', 'credentials',
      // an export stamped with a date and time, and words that only contain "token"
      'export-202401011230.json', 'tokenizer.json', 'tokens_used.csv']) {
      expect(isSensitive(p), p).toBe(false);
    }
  });
});
