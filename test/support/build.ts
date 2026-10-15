// Vitest global setup: build dist/ once, before any test file runs. The stdio and README tests start the
// built server, so they must run what ships, built from the current source (dist/ is emptied first, so
// no file of a deleted source is left to test); one build also avoids two test files writing dist/ at
// the same time. It also says, where everyone sees it, when this machine cannot run the file-link tests
// (they skip here and run on Linux CI), runs the tests as root or on Windows, where the permission tests
// skip, or runs a Node.js too old to measure one thread's memory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';

function canLinkFiles(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'money-guard-link-'));
  try {
    writeFileSync(path.join(dir, 'target'), '');
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default function build(): void {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const repo = path.resolve(import.meta.dirname, '..', '..');
  rmSync(path.join(repo, 'dist'), { recursive: true, force: true });
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    const { stdout = '', stderr = '' } = err as { stdout?: string; stderr?: string };
    throw new Error(`Building dist/ failed:\n${stdout}${stderr}`, { cause: err });
  }
  if (!canLinkFiles()) {
    console.warn('\nNOTE: this machine cannot create file symlinks (Windows without Developer Mode), so the tests of file links skip here. CI is set up to run them: its runners may create links.\n');
  }
  if (process.getuid?.() === 0) {
    console.warn('\nNOTE: the tests run as root, who may read any file, so the 3 tests of files nobody may read skip here. CI runs them as an ordinary user.\n');
  }
  if (process.platform === 'win32') {
    console.warn('\nNOTE: Windows has no POSIX file permissions, so the 3 tests of files nobody may read skip here, and 1 Linux-only test of the piped stderr. CI runs them on Linux.\n');
  }
  if (!('getHeapStatistics' in Worker.prototype)) {
    console.warn("\nNOTE: this Node.js cannot measure one thread's memory (22.16 and later can), so the 2 tests of that measure skip here.\n");
  }
}
