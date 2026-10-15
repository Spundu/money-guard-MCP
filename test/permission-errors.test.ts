// File-system errors that this machine cannot be made to raise (SPEC.md §2.2, §2.3): EPERM, which Windows
// raises where POSIX raises EACCES, and EBUSY, a file another program has locked. node:fs is wrapped so
// that one call can fail with such an error; every other call goes through.
import * as fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { ToolError } from '../src/errors.js';
import { deniedOrLocked, resolveInRoot, unreadable } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, accessSync: vi.fn(real.accessSync), realpathSync: Object.assign(vi.fn(real.realpathSync), { native: vi.fn(real.realpathSync.native) }) };
});

const failWith = (code: string) => () => {
  throw Object.assign(new Error(`${code}: operation not permitted`), { code });
};

afterEach(() => {
  vi.mocked(fs.accessSync).mockReset();
  vi.mocked(fs.realpathSync.native).mockReset();
});

describe('a file or folder the system will not let the server read', () => {
  it('counts EACCES, EPERM and EBUSY as there but unreadable, and nothing else', () => {
    for (const code of ['EACCES', 'EPERM', 'EBUSY']) expect(deniedOrLocked({ code }), code).toBe(true);
    for (const code of ['ENOENT', 'ENOTDIR', undefined]) expect(deniedOrLocked({ code }), String(code)).toBe(false);
  });

  it('says why a file cannot be read: locked by another program, or permission denied', () => {
    expect(unreadable('exports/l.csv', { code: 'EBUSY' }).message).toBe('"exports/l.csv" is locked by another program.');
    expect(unreadable('exports/l.csv', { code: 'EPERM' }).message).toBe('"exports/l.csv" cannot be read (permission denied).');
    expect(unreadable('exports/l.csv', { code: 'EACCES' }).message).toBe('"exports/l.csv" cannot be read (permission denied).');
  });

  it('gives each cause its own fix: a file that went away is not a lock or a permission', () => {
    // Review round 7: "no longer exists" was told to close the program that holds it.
    expect(['EBUSY', 'EACCES', 'ENOENT'].map((code) => unreadable('exports/l.csv', { code }).fix)).toEqual([
      'Close the program that holds it, then call again.',
      'Give the user that runs the server read access to it, then call again.',
      'It was moved or deleted while the tool read it: check the path, then call again.',
    ]);
  });

  it.each(['EPERM', 'EBUSY'])('answers FILE_UNREADABLE, not that the file does not exist, when finding its real path fails with %s', (code) => {
    const dir = tempDir();
    writeTree(dir, { 'exports/l.csv': 't,a\n' });
    const root = rootOf(dir);
    vi.mocked(fs.realpathSync.native).mockImplementationOnce(failWith(code));
    let error: unknown;
    try {
      resolveInRoot(root, 'exports/l.csv', { kind: 'file', extensions: ['.csv'] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('FILE_UNREADABLE');
  });

  it('says a project folder the server may not open is not open to it, not that it does not exist (EPERM)', () => {
    const dir = path.join(tempDir(), 'project');
    fs.mkdirSync(dir);
    vi.mocked(fs.accessSync).mockImplementationOnce(failWith('EPERM'));
    const root = resolveConfig({ MONEY_GUARD_ROOT: dir }, dir).root;
    expect(root.ok ? 'ok' : root.error.message).toBe('The project root (from MONEY_GUARD_ROOT) cannot be opened (permission denied).');
  });
});
