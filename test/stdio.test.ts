// The built server as a real process on stdio (SPEC.md §7): both protocol eras through the SDK's own
// stdio client, then a raw byte-level check that stdout carries nothing but protocol messages, even
// when a migration raises NOTICEs and WARNINGs.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { tempDir, writeTree } from './support/tmp.js';

const REPO = path.resolve(import.meta.dirname, '..');
// What ships: test/support/build.ts builds it from the current source before the tests run.
const ENTRY = path.join(REPO, 'dist', 'index.js');

/** The built server as a process spoken to in raw JSON-RPC lines, for what the SDK client hides. */
function raw(env: Record<string, string>, nodeOptions: readonly string[] = []) {
  const child = spawn(process.execPath, [...nodeOptions, ENTRY], { env: { ...getDefaultEnvironment(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  child.stderr.on('error', () => {});
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const answered = (id: number) => vi.waitFor(() => expect(stdout).toContain(`"id":${id}`), { timeout: 10_000 });
  return {
    child,
    send,
    answered,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: new Promise<number | null>((resolve) => child.on('exit', resolve)),
    async initialize() {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
      await answered(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
  };
}

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

  it('keeps answering after the host closes its stderr: a log line must not turn into an endless EPIPE loop', async () => {
    const server = raw({ MONEY_GUARD_ROOT: SHOP });
    try {
      await server.initialize();
      server.child.stderr.destroy(); // the host stops reading the log
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_check_double_entry', arguments: { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } } });
      await server.answered(2);
      server.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
      await server.answered(3);
    } finally {
      server.child.kill();
    }
  });

  it('keeps answering when the host never reads its stderr: a full log pipe must not stop the server', async () => {
    // On Windows Node writes to a pipe synchronously: the write waits until the other end reads. Nothing
    // reads this one, and 6,000 logged calls (about 330 KB of log, in batches so that the log reaches
    // the pipe between them) fill it several times over.
    const child = spawn(process.execPath, [ENTRY], { env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: SHOP }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    try {
      const messages: object[] = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ];
      for (let id = 2; id <= 6001; id += 1) messages.push({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'audit_verify_chain', arguments: { file: 'nope.jsonl' } } });
      for (let i = 0; i < messages.length; i += 50) {
        child.stdin.write(`${messages.slice(i, i + 50).map((m) => JSON.stringify(m)).join('\n')}\n`);
        await new Promise((r) => setTimeout(r, 10));
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'ping' })}\n`);
      // Review round 8: on a slow disk (WSL reading /mnt/c) the 6,000 calls took over a minute while
      // answers kept coming. What must not happen is that answers stop: fail after 20 s without one.
      let answers = -1;
      let quiet = 0;
      while (!stdout.includes('"id":9999')) {
        await new Promise((r) => setTimeout(r, 1000));
        const now = stdout.split('"id":').length - 1;
        quiet = now === answers ? quiet + 1 : 0;
        answers = now;
        expect(quiet, `no answer for 20 s after ${answers} answers`).toBeLessThan(20);
      }
      // Review round 16: and when the host then closes stdin, the server still exits.
      child.stdin.end();
      expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 15_000))])).toBe(0);
    } finally {
      child.kill();
    }
  }, 300_000);

  it('does not run a call the client cancelled before it ran, logs it CANCELLED, and sends no answer for it', async () => {
    // A million rows take seconds to check; cancelled before it ran, the call is not run at all.
    const project = tempDir();
    const rows = Array.from({ length: 1_000_000 }, (_, i) => `T${i >> 1},${i % 2 === 0 ? 100 : -100}`);
    writeTree(project, { 'exports/big.csv': `txn_id,amount_pence\n${rows.join('\n')}\n` });
    const server = raw({ MONEY_GUARD_ROOT: project });
    try {
      await server.initialize();
      const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_check_double_entry', arguments: { file: 'exports/big.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } } };
      const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'changed my mind' } };
      server.child.stdin.write(`${JSON.stringify(call)}\n${JSON.stringify(cancel)}\n`);
      server.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
      await server.answered(3);
      await vi.waitFor(() => expect(server.stderr()).toMatch(/money-guard-mcp: money_check_double_entry CANCELLED \d+ms/), { timeout: 5000 });
      expect(Number(/money_check_double_entry CANCELLED (\d+)ms/.exec(server.stderr())?.[1])).toBeLessThan(500);
      expect(server.stdout()).not.toContain('"id":2');
    } finally {
      server.child.kill();
    }
  }, 60_000);

  it('answers a ledger call and logs it ok when the cancel comes only while it runs: it cannot be stopped part-way', async () => {
    // SPEC.md §2.6. A million rows take seconds to check; the cancel is read only once the check has ended.
    const project = tempDir();
    const rows = Array.from({ length: 1_000_000 }, (_, i) => `T${i >> 1},${i % 2 === 0 ? 100 : -100}`);
    writeTree(project, { 'exports/big.csv': `txn_id,amount_pence\n${rows.join('\n')}\n` });
    const server = raw({ MONEY_GUARD_ROOT: project });
    try {
      await server.initialize();
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_check_double_entry', arguments: { file: 'exports/big.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } } });
      await new Promise((r) => setTimeout(r, 500)); // the check has started
      server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'too slow' } });
      await vi.waitFor(() => expect(server.stdout()).toContain('"id":2'), { timeout: 30_000 });
      expect(server.stdout()).toContain('Balanced: all 500,000 transactions net to zero');
      await vi.waitFor(() => expect(server.stderr()).toMatch(/money-guard-mcp: money_check_double_entry ok \d+ms/), { timeout: 5000 });
      expect(server.stderr()).not.toContain('CANCELLED');
    } finally {
      server.child.kill();
    }
  }, 60_000);

  it('answers a ledger call and logs it ok when stdin closes while it runs, then exits', async () => {
    // Review round 16: SPEC.md §2.1 promised it, and no test ran it.
    const project = tempDir();
    const rows = Array.from({ length: 1_000_000 }, (_, i) => `T${i >> 1},${i % 2 === 0 ? 100 : -100}`);
    writeTree(project, { 'exports/big.csv': `txn_id,amount_pence\n${rows.join('\n')}\n` });
    const server = raw({ MONEY_GUARD_ROOT: project });
    try {
      await server.initialize();
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_check_double_entry', arguments: { file: 'exports/big.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } } });
      await new Promise((r) => setTimeout(r, 500)); // the check has started
      server.child.stdin.end();
      expect(await Promise.race([server.exited, new Promise((r) => setTimeout(() => r('still running'), 30_000))])).toBe(0);
      expect(server.stdout()).toContain('Balanced: all 500,000 transactions net to zero');
      // Review round 17: the call took well past the 500 ms at which stdin closed, so it was running then.
      const took = Number(/money-guard-mcp: money_check_double_entry ok (\d+)ms/.exec(server.stderr())?.[1] ?? 0);
      expect(took).toBeGreaterThan(700);
    } finally {
      server.child.kill();
    }
  }, 60_000);

  it('keeps serving after an error that no handler caught and a rejection that no one handled, and logs only their types', async () => {
    const signal = path.join(tempDir(), 'throw');
    const server = raw({ MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_TEST_THROW: signal }, ['--import', pathToFileURL(path.join(REPO, 'test', 'support', 'throw-later.mjs')).href]);
    try {
      await server.initialize();
      writeFileSync(signal, '');
      await vi.waitFor(() => expect(server.stderr()).toMatch(/^money-guard-mcp: unhandled rejection RangeError/m), { timeout: 10_000 });
      expect(server.stderr()).toMatch(/^money-guard-mcp: uncaught TypeError/m);
      expect(server.stderr()).not.toContain('secret detail');
      server.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      await server.answered(2);
    } finally {
      server.child.kill();
    }
  });

  // A piped stderr that blocks would hold a thread of libuv's pool while a host does not read the log.
  it.runIf(process.platform === 'linux')('makes its piped stderr non-blocking on Linux, so a log write never waits for the host', async () => {
    const server = raw({ MONEY_GUARD_ROOT: SHOP });
    try {
      await server.initialize();
      const flags = Number.parseInt(/flags:\s+(\d+)/.exec(readFileSync(`/proc/${server.child.pid}/fdinfo/2`, 'utf8'))?.[1] ?? '0', 8);
      expect(flags & 0o4000).toBe(0o4000); // O_NONBLOCK
    } finally {
      server.child.kill();
    }
  });

  it('logs a lint cut short by the client going away as DISCONNECTED, then exits', async () => {
    const project = tempDir();
    writeTree(project, { 'endless/0001.sql': 'do $$ begin loop end loop; end $$;' });
    const server = raw({ MONEY_GUARD_ROOT: project });
    await server.initialize();
    server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'money_lint_schema', arguments: { migrations: 'endless' } } });
    await new Promise((r) => setTimeout(r, 1000));
    server.child.stdin.end();
    expect(await Promise.race([server.exited, new Promise((r) => setTimeout(() => r('still running'), 15_000))])).toBe(0);
    expect(server.stderr()).toMatch(/money-guard-mcp: money_lint_schema DISCONNECTED \d+ms/);
  }, 30_000);

  it('says in its startup line that the audit keys are malformed, not that there are none', async () => {
    const server = raw({ MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_AUDIT_KEYS: 'k1=not-hex' });
    try {
      await vi.waitFor(() => expect(server.stderr()).toContain('audit keys malformed (the audit tool answers KEYS_INVALID).'), { timeout: 10_000 });
      expect(server.stderr()).not.toContain('not-hex');
    } finally {
      server.child.kill();
    }
  });

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
