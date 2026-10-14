// The built server as a real process on stdio (SPEC.md §7): both protocol eras through the SDK's own
// stdio client, then a raw byte-level check that stdout carries nothing but protocol messages, even
// when a migration raises NOTICEs and WARNINGs.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { tempDir, writeTree } from './support/tmp.js';

const REPO = path.resolve(import.meta.dirname, '..');
// What ships: test/support/build.ts builds it from the current source before the tests run.
const ENTRY = path.join(REPO, 'dist', 'index.js');

async function connect(era: 'modern' | 'legacy', env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'money-guard-stdio-tests', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await client.connect(transport);
  return client;
}

describe.each(['modern', 'legacy'] as const)('the stdio process, %s era', (era) => {
  it('serves the three tools and runs a schema lint end to end', async () => {
    const client = await connect(era, { MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` });
    try {
      expect(client.getProtocolEra()).toBe(era);
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['money_lint_schema', 'money_check_double_entry', 'audit_verify_chain']);
      const lint = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
      expect((lint.structuredContent as { summary: string }).summary).toBe('2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.');
      const audit = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } });
      expect((audit.structuredContent as { ok: boolean }).ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the stdio process', () => {
  it('takes the project folder from CLAUDE_PROJECT_DIR, as Claude Code sets it', async () => {
    const client = await connect('modern', { CLAUDE_PROJECT_DIR: SHOP });
    try {
      const r = await client.callTool({ name: 'money_check_double_entry', arguments: { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } });
      expect(r.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('stops a running lint when the client cancels it, logs that, and serves the next lint at once', async () => {
    const project = tempDir();
    writeTree(project, { 'endless/0001.sql': 'do $$ begin loop end loop; end $$;', 'ok/0001.sql': 'create table t (price double precision);' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: project }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const client = new Client({ name: 'money-guard-stdio-tests', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(transport);
    try {
      const controller = new AbortController();
      const call = client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'endless' } }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 3000);
      await expect(call).rejects.toThrow();
      // Had the cancelled lint kept running (until its 45-second limit), this one would get BUSY.
      const next = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'ok' } });
      expect([next.isError ?? false, (next.structuredContent as { error_count?: number } | undefined)?.error_count]).toEqual([false, 1]);
      await vi.waitFor(() => expect(stderr).toMatch(/money-guard-mcp: money_lint_schema CANCELLED \d+ms/), { timeout: 5000 });
    } finally {
      await client.close();
    }
  }, 60_000);

  it('logs a message too large for stdio (the SDK stops reading past 10 MiB) instead of ending in silence', async () => {
    const child = spawn(process.execPath, [ENTRY], { env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: SHOP }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.stdin.on('error', () => {}); // the server stops reading part-way: that is what is under test
    const pad = 'x'.repeat(11 * 1024 * 1024);
    child.stdin.write(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"money_lint_schema","arguments":{"migrations":"${pad}"}}}\n`);
    child.stdin.end();
    await exited;
    expect(stderr).toMatch(/^money-guard-mcp: transport error \(\w+\)$/m);
    expect(stderr).not.toContain('xxxxxxxx');
  }, 30_000);

  it('writes nothing but protocol messages to stdout, and no file content to stderr, then exits when stdin closes', async () => {
    const project = tempDir();
    writeTree(project, {
      'db/migrations/0001.sql': "do $$ begin raise notice 'notice from a migration'; raise warning 'warning from a migration'; end $$;\ncreate table t (price double precision);\n",
    });
    const child = spawn(process.execPath, [ENTRY], { env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: project }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } } });
    const deadline = Date.now() + 60_000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    child.stdin.end();
    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 10_000))])).toBe(0);

    const lines = stdout.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    const result = (JSON.parse(lines[1] ?? '{}') as { result: { structuredContent: { error_count: number } } }).result;
    expect(result.structuredContent.error_count).toBe(1);
    expect(stdout + stderr).not.toContain('from a migration');
    expect(stderr).toContain(`project folder "${path.basename(project)}"`);
    expect(stderr).not.toContain(project);
  });
});
