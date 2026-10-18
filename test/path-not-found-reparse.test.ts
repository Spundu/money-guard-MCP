// A Dirent on Windows calls every reparse point a link, OneDrive's Files On-Demand placeholders too, though
// lstat and every read see a plain file (review round 25). A placeholder cannot be made in CI, so this
// folder listing says so of one real file, as libuv does.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveInRoot } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const opendirSync = (dir: string): fs.Dir => {
    const open = real.opendirSync(dir);
    const readSync = (): fs.Dirent | null => {
      const entry = open.readSync();
      if (entry?.name !== 'placeholder.csv') return entry;
      return Object.assign(Object.create(entry) as fs.Dirent, { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true });
    };
    return Object.assign(Object.create(open) as fs.Dir, { readSync, closeSync: () => open.closeSync() });
  };
  return { ...real, default: { ...real, opendirSync }, opendirSync };
});

describe('PATH_NOT_FOUND lists a reparse point that lstat calls a file', () => {
  it('asks lstat, as resolveInRoot does, before it leaves an entry out as a link', () => {
    const base = tempDir();
    writeTree(path.join(base, 'project'), { 'exports/placeholder.csv': 'x', 'exports/plain.csv': 'x' });
    let text = '';
    try {
      resolveInRoot(rootOf(path.join(base, 'project')), 'exports/journl.csv', { kind: 'file', extensions: ['.csv'] });
    } catch (err) {
      text = (err as Error).message;
    }
    expect(text).toBe('"exports/journl.csv" does not exist. The nearest existing folder is "exports", which holds: "placeholder.csv", "plain.csv".');
  });
});
