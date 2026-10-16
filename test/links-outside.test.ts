// A link that leads out of the project is refused before it is followed (SPEC.md §2.3): nothing past the
// project's edge is opened, so a link to a share (\\host\share) or an automount (/net/host) never makes a
// network request (review round 19). Seen here through a loop of links outside the project: only a path
// that was followed out there could find it.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { collectSources } from '../src/lint/files.js';
import { resolveInRoot } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

function codeOf(call: () => unknown): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
}

describe('a link out of the project', () => {
  it('is refused as outside, without following it there', (ctx) => {
    const base = tempDir();
    writeTree(base, { 'p/db/0001.sql': 'select 1;', 'out/keep.txt': 'x' });
    const loop = path.join(base, 'out', 'loop');
    if (!trySymlink(loop, loop, 'dir') || !trySymlink(loop, path.join(base, 'p', 'door'), 'dir') || !trySymlink(loop, path.join(base, 'p', 'db', 'sub'), 'dir')) {
      ctx.skip(); // this machine cannot create links
      return;
    }
    const root = rootOf(path.join(base, 'p'));
    expect(codeOf(() => resolveInRoot(root, 'door/x/0001.sql', { kind: 'file', extensions: ['.sql'] }))).toBe('PATH_OUTSIDE_ROOT');
    expect(codeOf(() => collectSources(root, { migrations: 'db' }))).toBe('PATH_OUTSIDE_ROOT');
  });
});
