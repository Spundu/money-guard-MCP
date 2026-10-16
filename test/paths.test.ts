// Which files the tools may read (src/paths.ts, SPEC.md §2.3): confinement to the project, secret files,
// file types, sizes, links, and a file that passes the checks but cannot be read.
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { checkLedgerFile } from '../src/ledger/run.js';
import { collectSources } from '../src/lint/files.js';
import { isSensitive, readChecked, resolveInRoot, type PathRule, type Root } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

const CSV: PathRule = { kind: 'file', extensions: ['.csv', '.json'] };
const ANY: PathRule = { kind: 'either' };

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
    'outside/other.csv': 'a,b\n',
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
    expect(resolveInRoot(root, '.', ANY).rel).toBe('.');
  });

  it('treats a name that merely starts with two dots as an ordinary file', () => {
    expect(resolveInRoot(root, 'exports/..odd.csv', CSV).rel).toBe('exports/..odd.csv');
    expect(resolveInRoot(root, '..top.csv', CSV).rel).toBe('..top.csv');
  });

  it('refuses a path outside the project before touching the disk (no existence oracle)', () => {
    expect(codeOf(() => resolveInRoot(root, '../outside/other.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, '../outside/does-not-exist.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, path.join(base, 'outside', 'other.csv'), CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'exports/../../outside/other.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    // The parent folder itself, as a folder argument (migrations: ".."), is outside too.
    for (const parent of ['..', '../', 'exports/../..', path.dirname(root.real)]) {
      expect(codeOf(() => resolveInRoot(root, parent, ANY)), parent).toBe('PATH_OUTSIDE_ROOT');
    }
  });

  it.skipIf(process.platform !== 'win32')('says on Windows that a Git Bash path (/c/Users/...) is not understood', () => {
    const gitBash = `/${root.real.slice(0, 1).toLowerCase()}${root.real.slice(2).split(path.sep).join('/')}/exports/ledger.csv`;
    const text = messageOf(() => resolveInRoot(root, gitBash, CSV));
    expect(text).toMatch(/^PATH_OUTSIDE_ROOT: /);
    expect(text).toContain('Git Bash paths such as /c/Users/... are not understood.');
    expect(messageOf(() => resolveInRoot(root, '/tmp/exports/ledger.csv', CSV))).toContain('Git Bash paths'); // any path starting with "/"
    expect(messageOf(() => resolveInRoot(root, path.join(base, 'outside', 'other.csv'), CSV))).not.toContain('Git Bash');
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
    const text = messageOf(() => resolveInRoot(root, '../outside/other.csv', CSV));
    expect(text).toContain(`the project folder "${root.name}".`);
    expect(text).not.toContain(root.real);
  });

  it('checks the kind of entry and the size limit', () => {
    expect(codeOf(() => resolveInRoot(root, 'exports', { kind: 'file' }))).toBe('NOT_A_FILE');
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

  it('answers NOT_A_FILE for a folder where a file is expected, and still refuses a file of no type', () => {
    // Review round 12: through the ledger's rule a folder was "not one of the file types this tool reads".
    const dir = tempDir();
    writeTree(dir, { 'exports/a.csv': 'a\n', 'noext': 'a\n' });
    expect(codeOf(() => resolveInRoot(rootOf(dir), 'exports', CSV))).toBe('NOT_A_FILE');
    expect(codeOf(() => resolveInRoot(rootOf(dir), 'noext', CSV))).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('refuses a folder link that leads outside the project', () => {
    // Folder links need no privilege (junctions on Windows), so this half never skips.
    expect(trySymlink(path.join(base, 'outside'), path.join(root.real, 'outdir'), 'dir')).toBe(true);
    expect(codeOf(() => resolveInRoot(root, 'outdir/other.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'outdir', ANY))).toBe('PATH_OUTSIDE_ROOT');
    // Whether a path behind the link exists must not show: missing files and folders get the same answer.
    for (const missing of ['outdir/missing.csv', 'outdir/no/such/folder/x.csv', 'outdir/nope']) {
      expect(codeOf(() => resolveInRoot(root, missing, missing.endsWith('.csv') ? CSV : ANY)), missing).toBe('PATH_OUTSIDE_ROOT');
    }
  });

  it('gives a link to a missing place outside the project the answer a link to an existing one gets', () => {
    // Review round 9: "does not exist" for one and "outside" for the other told a hostile repository
    // which paths exist on the user's machine. A chain of links that ends outside counts too.
    const dir = tempDir();
    writeTree(dir, { 'project/db/migrations/0001.sql': 'select 1;', 'outside/real/x.sql': 'select 1;' });
    const project = path.join(dir, 'project');
    const links: Array<[string, string]> = [
      [path.join(dir, 'outside', 'real'), path.join(project, 'exists')],
      [path.join(dir, 'outside', 'no-such-folder'), path.join(project, 'missing')],
      [path.join(project, 'missing'), path.join(project, 'hop')],
      [path.join(project, 'no-such-folder'), path.join(project, 'broken')],
    ];
    for (const [target, link] of links) expect(trySymlink(target, link, 'dir')).toBe(true);
    const r = rootOf(project);
    for (const input of ['exists', 'missing', 'hop', 'exists/nope.csv', 'missing/nope.csv', 'hop/nope.csv']) {
      expect(codeOf(() => resolveInRoot(r, input, input.endsWith('.csv') ? CSV : ANY)), input).toBe('PATH_OUTSIDE_ROOT');
    }
    expect(codeOf(() => resolveInRoot(r, 'broken', ANY))).toBe('PATH_NOT_FOUND'); // missing, and inside
    // The migrations walk, likewise.
    for (const [link, code] of [['exists', 'PATH_OUTSIDE_ROOT'], ['missing', 'PATH_OUTSIDE_ROOT'], ['hop', 'PATH_OUTSIDE_ROOT'], ['broken', 'PATH_NOT_FOUND']] as const) {
      writeTree(project, { [`walk-${link}/0001.sql`]: 'select 1;' });
      expect(trySymlink(path.join(project, link), path.join(project, `walk-${link}`, 'm'), 'dir')).toBe(true);
      expect(codeOf(() => collectSources(r, { migrations: `walk-${link}` })), link).toBe(code);
    }
  });

  it('answers a chain of more links than can be followed the same way, wherever it ends', () => {
    // Review round 10: past 40 links the answer said whether a folder outside existed (Windows follows 63).
    const dir = tempDir();
    writeTree(dir, { 'project/x.csv': 'a\n', 'outside/real/x.csv': 'a\n' });
    const project = path.join(dir, 'project');
    const chain = (name: string, end: string, length: number) => {
      for (let i = length; i >= 1; i -= 1) expect(trySymlink(i === length ? end : path.join(project, `${name}${i + 1}`), path.join(project, `${name}${i}`), 'dir')).toBe(true);
    };
    // 50 links: Windows follows them to a place that exists (it stops at 63, Linux at 40); 70: nobody does.
    for (const length of [50, 70]) {
      chain(`e${length}_`, path.join(dir, 'outside', 'real'), length);
      chain(`m${length}_`, path.join(dir, 'outside', 'no-such-folder'), length);
    }
    const r = rootOf(project);
    for (const length of [50, 70]) {
      const answers = [`e${length}_1`, `m${length}_1`, `e${length}_1/x.csv`, `m${length}_1/x.csv`].map((p) =>
        messageOf(() => resolveInRoot(r, p, p.endsWith('.csv') ? CSV : ANY)).replace(/"[em]\d+_1/, '"?'),
      );
      expect(new Set(answers.slice(0, 2)).size, `${length}`).toBe(1);
      expect(new Set(answers.slice(2)).size, `${length}`).toBe(1);
    }
    // Review round 11: what the answer is, for a chain too long and for a loop, in both checks.
    const tooMany = /^PATH_NOT_FOUND: "[^"]+" goes through more links than can be followed \(a loop, a chain of more than 64, or more parts of link texts than one call reads, 2,000,000\)\./;
    expect(messageOf(() => resolveInRoot(r, 'e70_1', ANY))).toMatch(tooMany);
    expect(trySymlink(path.join(project, 'loop_b'), path.join(project, 'loop_a'), 'dir')).toBe(true);
    expect(trySymlink(path.join(project, 'loop_a'), path.join(project, 'loop_b'), 'dir')).toBe(true);
    for (const p of ['loop_a', 'loop_a/x.csv']) expect(messageOf(() => resolveInRoot(r, p, p.endsWith('.csv') ? CSV : ANY)), p).toMatch(tooMany);
    writeTree(project, { 'walk_loop/0001.sql': 'select 1;' });
    expect(trySymlink(path.join(project, 'loop_a'), path.join(project, 'walk_loop', 'l'), 'dir')).toBe(true);
    expect(messageOf(() => collectSources(r, { migrations: 'walk_loop' }))).toMatch(tooMany);
  });

  it('looks no deeper than 100 folders, links to folders included, instead of overflowing the stack', () => {
    // Review round 9: a chain of 3,000 folder links (git checks them out on Linux) gave INTERNAL_ERROR.
    const dir = tempDir();
    writeTree(dir, { [`deep/${'d/'.repeat(100)}0001.sql`]: 'select 1;', [`deeper/${'d/'.repeat(101)}0001.sql`]: 'select 1;' });
    expect(collectSources(rootOf(dir), { migrations: 'deep' }).files.length).toBe(1);
    expect(() => collectSources(rootOf(dir), { migrations: 'deeper' })).toThrow(/^The folder nests folders \(or links to folders\) more than 100 deep; /);
    const links = tempDir();
    writeTree(links, { 'm/d0/0001.sql': 'select 1;' });
    for (let i = 1; i <= 101; i += 1) {
      mkdirSync(path.join(links, 'm', `d${i}`));
      expect(trySymlink(path.join(links, 'm', `d${i - 1}`), path.join(links, 'm', `d${i}`, 'l'), 'dir')).toBe(true);
    }
    expect(codeOf(() => collectSources(rootOf(links), { migrations: 'm/d101' }))).toBe('TOO_MANY_FILES');
  });

  it('refuses a folder link in the migrations folder that leads to the .git folder', () => {
    // Review round 8 (tests): the file-link tests skip on Windows without Developer Mode; a folder
    // link needs no privilege, so the walk's secret check is proven everywhere.
    const dir = tempDir();
    writeTree(dir, { '.git/hooks/0001.sql': 'select 1;', 'db/migrations/0001.sql': 'select 1;' });
    expect(trySymlink(path.join(dir, '.git'), path.join(dir, 'db', 'migrations', 'vendor'), 'dir')).toBe(true);
    expect(codeOf(() => collectSources(rootOf(dir), { migrations: 'db/migrations' }))).toBe('SENSITIVE_PATH');
  });

  it('refuses a file link that leads outside the project', (ctx) => {
    if (!trySymlink(path.join(base, 'outside', 'other.csv'), path.join(root.real, 'exports', 'out.csv'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(codeOf(() => resolveInRoot(root, 'exports/out.csv', CSV))).toBe('PATH_OUTSIDE_ROOT');
    // Review round 10: ".." in a link's text goes up from where the link before it led, so "d/../x"
    // through d, a link outside, is outside whether x exists there or not.
    const dir = tempDir();
    writeTree(dir, { 'project/a.csv': 'a\n', 'outside/sub/x.csv': 'a\n', 'outside/exists.csv': 'a\n' });
    const project = path.join(dir, 'project');
    expect(trySymlink(path.join(dir, 'outside', 'sub'), path.join(project, 'd'), 'dir')).toBe(true);
    symlinkSync('d/../exists.csv', path.join(project, 'yes.csv'), 'file');
    symlinkSync('d/../missing.csv', path.join(project, 'no.csv'), 'file');
    const r = rootOf(project);
    expect(['yes.csv', 'no.csv'].map((p) => codeOf(() => resolveInRoot(r, p, CSV)))).toEqual(['PATH_OUTSIDE_ROOT', 'PATH_OUTSIDE_ROOT']);
  });

  it('refuses an innocent-looking link to a secret file inside the project', (ctx) => {
    if (!trySymlink(path.join(root.real, '.env'), path.join(root.real, 'exports', 'notes.csv'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(codeOf(() => resolveInRoot(root, 'exports/notes.csv', CSV))).toBe('SENSITIVE_PATH');
  });

  it('refuses a path through a folder link into .git, on every machine', () => {
    // Review round 15: the test above skips on Windows without Developer Mode; a junction needs no
    // privilege, so the check of the real path is tested there too.
    const dir = tempDir();
    writeTree(dir, { '.git/export.csv': 'a\n' });
    expect(trySymlink(path.join(dir, '.git'), path.join(dir, 'reports'), 'dir')).toBe(true);
    expect(codeOf(() => resolveInRoot(rootOf(dir), 'reports/export.csv', CSV))).toBe('SENSITIVE_PATH');
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
      'my-project-1a2b3c4d5e6f.json', 'token.json',
      // review round 5: key files, a secrets file with a dot, access tokens, auth.json
      'key.json', 'sa-key.json', 'firebase-key.json', '.secrets.json', 'accessTokens.json', 'auth.json',
      // review round 10: more credential names
      'secret.json', 'app-secret.json', '.secret.json', 'apikeys.json', 'api_keys.json', 'api-key.json', 'access-keys.csv', 'aws_access_key.csv',
      'passwords.csv', 'password.json', 'keyfile.json', 'oauth-token.json',
      // review round 11: a 40-character secret fits the echo limit whole, so these words count anywhere
      'app_secrets.json', 'prod-secrets.json', 'client-secrets.json', 'access_token.json', 'auth_token.json', 'github-token.json',
      'credential.json', 'creds.csv', 'privatekey.json', 'secretkey.json', 'id_token.json', 'refresh-token.json', 'bearer_token.csv',
      // review round 12: password-manager and wallet exports, Azure's and Docker's local secrets
      'logins.csv', 'bitwarden_export_20240101.json', 'lastpass_export.csv', 'keystore.json', 'local.settings.json', 'home/.docker/config.json',
      // review round 13: every type the ledger tool reads
      'credentials.tsv', 'app_secrets.jsonl', 'access_token.ndjson',
      // review round 14: a second download, a dated copy, and passwords as a word
      'logins (1).csv', 'logins-2026-10-16.csv', 'logins_backup.json', 'keystore (1).json', 'Chrome Passwords (1).csv', 'Passwords (2).csv', 'passwords-export.csv',
      // review round 15: words between spaces or brackets, and two-word names with a space
      'Dashlane Export.csv', 'KeePass Export.csv', 'LastPass Export.csv', 'Bitwarden Export.json', 'my secrets.json', 'Secrets (1).json',
      'app secret.json', 'api key.json', 'access token.json', 'service account.json',
      // review round 15: camelCase words, and a second download of any of them
      'AWSCredentials.csv', 'GCPCredentials.json', 'DBPasswords.csv', 'JWTSecret.json', 'AWSSecrets.json', // round 16: an acronym first
      'firebaseCredentials.json', 'awsCredentials.csv', 'userPasswords.csv', 'ChromePasswords.csv', 'App Secrets.json', 'private key.json',
      'key - Copy.json', 'key - Copy (2).json', 'key copy.json', 'key copy 2.json', 'Copy of key.json', 'auth - Copy.json', 'token - Copy.json', 'myproject-1a2b3c4d5e6f - Copy.json', // round 16: system copies
      'key - Copy - Copy.json', 'key copy copy.json', 'Copy of Copy of key.json', 'key (1) - Copy.json', 'token - Copy (2) - Copy.json', 'myproject-1a2b3c4d5e6f - Copy - Copy.json', // round 17: copies of copies
      'token(1).json', 'key(1).json', 'sa-key(1).json', 'myproject-1a2b3c4d5e6f(1).json', 'secrets (1).json', 'access_token (1).json', 'token (1).json', 'key (1).json', 'auth (1).json', 'sa-key (1).json', 'myproject-1a2b3c4d5e6f (1).json']) {
      expect(isSensitive(p), p).toBe(true);
    }
    for (const p of [
      // review round 13: wallets and logins name ledgers too
      'wallet_transactions.csv', 'wallet.csv', 'wallet-2024-10.csv', 'customer_wallet_entries.json', 'customer_logins_revenue.csv', 'wallet_ledger.jsonl',
      'tokens_used 2024.json', 'monkey copy.json', // round 16: a number or "copy" alone does not make a name a copy of a secret
      'logins_revenue.csv', 'daily_logins.csv', 'customer_logins.csv', 'passwordless_signups.csv', 'credentialing_fees.csv', // round 14: logins as the whole name, password as a word
      'ledger.csv', 'environment.csv', 'db/migrations/0001.sql', 'keys.csv', 'monkey.json', '.github/x.csv', 'credit_notes.csv', 'secretary.csv', 'accessories.csv',
      // credential words in a migration or a folder name: not a credential download
      'db/migrations/0002_create_access_keys.sql', 'db/migrations/0003_client_secrets.sql', 'db/migrations/20240202_add_service_accounts', 'credentials',
      // an export stamped with a date and time, and words that only contain "token"
      'export-202401011230.json', 'tokenizer.json', 'tokens_used.csv', 'monkey_keys.json', 'keyboard.json', 'author.json']) {
      expect(isSensitive(p), p).toBe(false);
    }
  });
});
