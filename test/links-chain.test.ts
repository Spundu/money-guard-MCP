// Links are read once per call (SPEC.md §2.3), so a chain of links that many paths go through costs one walk,
// and a call that would read too many parts of links gets an answer instead of holding the server. Review
// round 20: a chain of 60 junctions held the server 63 s for 2,000 entries of files, and 5 s for a walk
// of 200 links into it, outside every time limit (the paths are checked before the database starts).
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ToolError } from '../src/errors.js';
import { collectSources } from '../src/lint/files.js';
import { newLinkWalk, resolveInRoot } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

function codeOf(call: () => unknown): string {
  try {
    call();
    return 'no error';
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
}

/** A project whose db/migrations/c leads through db/chain/J1 … J60 to db/migrations/target, with links to J1 in db/migrations/e. Undefined where links cannot be made. */
function chained(links: number): string | undefined {
  const dir = tempDir();
  writeTree(dir, { 'db/migrations/target/x.sql': 'select 1;', 'db/migrations/0001.sql': 'select 1;', 'db/chain/keep.txt': '' });
  for (let i = 60; i >= 1; i -= 1) {
    const to = i === 60 ? path.join(dir, 'db', 'migrations', 'target') : path.join(dir, 'db', 'chain', `J${i + 1}`);
    if (!trySymlink(to, path.join(dir, 'db', 'chain', `J${i}`), 'dir')) return undefined;
  }
  if (!trySymlink(path.join(dir, 'db', 'chain', 'J1'), path.join(dir, 'db', 'migrations', 'c'), 'dir')) return undefined;
  writeTree(dir, { 'db/migrations/e/keep.txt': '' });
  for (let i = 0; i < links; i += 1) trySymlink(path.join(dir, 'db', 'chain', 'J1'), path.join(dir, 'db', 'migrations', 'e', `k${i}`), 'dir');
  return dir;
}

describe('a chain of links', () => {
  it('is followed once for 2,000 entries of files that go through it', (ctx) => {
    const dir = chained(0);
    if (dir === undefined) return ctx.skip(); // this machine cannot create links
    const started = performance.now();
    let text = '';
    try {
      collectSources({ ...rootOf(dir), links: newLinkWalk() }, { migrations: 'db/migrations', files: Array.from({ length: 2000 }, () => 'c/x.sql') });
    } catch (err) {
      text = err instanceof ToolError ? err.toText() : String(err);
    }
    expect(text).toMatch(/ is named twice in files: /); // every entry is followed to the same file first
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('is followed once a call through the server too, which gives each call its own memory of links', async (ctx) => {
    const dir = chained(0);
    if (dir === undefined) return ctx.skip();
    const handler = createMcpHandler(() => createServer(resolveConfig({ MONEY_GUARD_ROOT: dir }, dir), () => {}));
    const client = new Client({ name: 'links-chain', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      const started = performance.now();
      const r = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations', files: Array.from({ length: 2000 }, () => 'c/x.sql') } });
      expect((r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')).toMatch(/ is named twice in files: /);
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it('is followed once for a walk of 200 links into it', (ctx) => {
    const dir = chained(200);
    if (dir === undefined) return ctx.skip();
    const started = performance.now();
    codeOf(() => collectSources({ ...rootOf(dir), links: newLinkWalk() }, { migrations: 'db/migrations' }));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Relative link texts: Windows junctions hold only absolute ones.
  it.skipIf(process.platform === 'win32')('charges each path the parts of link texts the system reads, up to 2,000,000 a call', () => {
    // 30 links one inside another (Linux follows 40), each "a/../" × 800 and the next one's name: 1,601 parts
    // each, 48,030 a path, read again by realpath for each path (62 ms on Linux). 41 paths fit, the 42nd not.
    const dir = tempDir();
    writeTree(dir, { 'a/keep.txt': '', 'end/x.sql': 'select 1;' });
    for (let i = 30; i >= 1; i -= 1) trySymlink(`${'a/../'.repeat(800)}${i === 30 ? 'end' : `L${i + 1}`}`, path.join(dir, `L${i}`), 'dir');
    const root = { ...rootOf(dir), links: newLinkWalk() };
    const codes = Array.from({ length: 50 }, () => codeOf(() => resolveInRoot(root, 'L1/x.sql', { kind: 'file', extensions: ['.sql'] })));
    expect(codes).toEqual([...Array.from({ length: 41 }, () => 'no error'), ...Array.from({ length: 9 }, () => 'PATH_NOT_FOUND')]);
    // A new call starts afresh.
    expect(codeOf(() => resolveInRoot({ ...rootOf(dir), links: newLinkWalk() }, 'L1/x.sql', { kind: 'file', extensions: ['.sql'] }))).toBe('no error');
  });
});
