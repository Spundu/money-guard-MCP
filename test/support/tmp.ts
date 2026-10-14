// Temporary project folders for tests: created under the OS temp folder, removed after each test file.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import type { Root } from '../../src/paths.js';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty folder, by its real path (the temp folder itself can be a link, as on macOS). */
export function tempDir(prefix = 'money-guard-'): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

/** Write `files` (relative path → content) under `dir`, creating folders as needed. */
export function writeTree(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export function rootOf(dir: string): Root {
  return { real: realpathSync.native(dir), name: path.basename(dir) };
}

/**
 * Try to create a symbolic link (a junction for folders on Windows, which needs no privilege). Returns
 * false where the OS refuses (Windows without Developer Mode), so the caller can skip LOUDLY.
 */
export function trySymlink(target: string, link: string, kind: 'file' | 'dir'): boolean {
  try {
    symlinkSync(target, link, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw err;
  }
}
