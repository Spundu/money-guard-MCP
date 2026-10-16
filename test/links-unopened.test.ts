// A path whose links lead out of the project, or round in a loop, is never given to realpath (SPEC.md §2.3
// rule 2): realpath would open what the link points at, a share (\\host\share) or an automount (/net/host).
// Review round 20: the answer alone cannot show this, as realpath then fails and the path is refused anyway,
// so these tests record every path realpath is given.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../src/errors.js';
import { collectSources } from '../src/lint/files.js';
import { resolveInRoot } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

const seen = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const record = (p: unknown) => seen.paths.push(path.resolve(String(p)));
  const native = (...args: Parameters<typeof real.realpathSync.native>) => (record(args[0]), real.realpathSync.native(...args));
  const realpathSync = Object.assign((...args: Parameters<typeof real.realpathSync>) => (record(args[0]), real.realpathSync(...args)), { native });
  return { ...real, realpathSync, default: { ...real, realpathSync } };
});

function codeOf(call: () => unknown): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
}

describe('a link out of the project, or a loop', () => {
  it('is never given to realpath, as an argument or in a folder walk', (ctx) => {
    const base = tempDir();
    writeTree(base, { 'p/db/0001.sql': 'select 1;', 'p/loops/keep.txt': '', 'out/keep.txt': 'x' });
    const p = path.join(base, 'p');
    const made = [
      trySymlink(path.join(base, 'out'), path.join(p, 'door'), 'dir'),
      trySymlink(path.join(base, 'out'), path.join(p, 'db', 'sub'), 'dir'),
      trySymlink(path.join(p, 'loops', 'a'), path.join(p, 'loops', 'a'), 'dir'),
    ];
    if (made.includes(false)) return ctx.skip(); // this machine cannot create links
    const root = rootOf(p);
    seen.paths.length = 0;
    expect(codeOf(() => resolveInRoot(root, 'door/x/0001.sql', { kind: 'file', extensions: ['.sql'] }))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => collectSources(root, { migrations: 'db' }))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => resolveInRoot(root, 'loops/a/x.sql', { kind: 'file', extensions: ['.sql'] }))).toBe('PATH_NOT_FOUND');
    const through = (link: string) => seen.paths.filter((s) => s === link || s.startsWith(`${link}${path.sep}`));
    expect([through(path.join(p, 'door')), through(path.join(p, 'db', 'sub')), through(path.join(p, 'loops', 'a'))]).toEqual([[], [], []]);
    expect(seen.paths.length).toBeGreaterThan(0); // realpath was watched: the folder itself was opened
  });
});
