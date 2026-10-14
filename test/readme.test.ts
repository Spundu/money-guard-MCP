// The README shows real things (a Phase A lesson: README examples drift unless CI runs them). Its
// source block is examples/demo.mjs byte for byte, its output block is what that file prints, and its
// JSON result is what the built server returns on the demo project.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { SHOP } from '../scripts/fixtures.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const README = readFileSync(path.join(REPO, 'README.md'), 'utf8');
const DEMO = path.join(REPO, 'examples', 'demo.mjs');

/** Every fenced block of the README in `language`, without its fences. */
function blocks(language: string): string[] {
  return [...README.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, 'gm'))].map((m) => m[1] ?? '');
}

describe('README.md', () => {
  it('shows examples/demo.mjs exactly', () => {
    expect(blocks('js')).toContain(readFileSync(DEMO, 'utf8'));
  });

  it('shows exactly what examples/demo.mjs prints', () => {
    // dist/ is built by test/support/build.ts. The server's own log lines go to stderr, not shown.
    const stdout = execFileSync(process.execPath, [DEMO], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(blocks('text')).toContain(stdout);
  });

  it('shows exactly the lint result the server returns on the demo project', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO, 'dist', 'index.js')],
      env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: SHOP },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'readme-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
      expect(blocks('json')).toContain(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
    } finally {
      await client.close();
    }
  });

  it('has only valid JSON in its JSON blocks', () => {
    const json = blocks('json');
    expect(json.length).toBeGreaterThan(1);
    for (const block of json) expect(() => JSON.parse(block)).not.toThrow();
  });
});
