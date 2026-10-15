// The server's last guard (src/server.ts, SPEC.md §2.4): every tool keeps its result within 20,000
// characters, and should one ever fail to, the server still never sends it. The model gets
// INTERNAL_ERROR without detail and the log names the cause. The audit checker's real result is padded
// here, in its summary, to the length a test sets.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { resolveConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const fake = vi.hoisted(() => ({ length: 0 }));

vi.mock('../src/audit/verify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/audit/verify.js')>();
  return {
    ...real,
    verifyAuditLog: (...args: Parameters<typeof real.verifyAuditLog>) => {
      const result = real.verifyAuditLog(...args);
      const rest = JSON.stringify({ ...result, summary: '' }).length;
      return { ...result, summary: 'x'.repeat(fake.length - rest) };
    },
  };
});

/** Calls audit_verify_chain with its result padded to `length` characters. */
async function callWith(length: number): Promise<{ isError: boolean; text: string; log: string[] }> {
  fake.length = length;
  const log: string[] = [];
  const config = resolveConfig({ MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, SHOP);
  const handler = createMcpHandler(() => createServer(config, (line) => log.push(line)));
  const client = new Client({ name: 'over-budget-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
  try {
    const r = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } });
    return { isError: r.isError === true, text: (r.content as Array<{ text: string }>)[0]?.text ?? '', log };
  } finally {
    await client.close();
    await handler.close();
  }
}

describe('a result over the budget', () => {
  it('is never sent: the model gets INTERNAL_ERROR, and the log says why', async () => {
    const r = await callWith(25_000);
    expect([r.isError, r.text]).toEqual([true, 'INTERNAL_ERROR: money-guard failed unexpectedly (OverBudgetError). Fix: This is a bug in money-guard: please report it. The server log has the details.']);
    expect(r.log.at(-1)).toMatch(/^money-guard-mcp: audit_verify_chain INTERNAL_ERROR \d+ms OverBudgetError/);
  });

  it('is sent at exactly 20,000 characters, and not at 20,001', async () => {
    const at = await callWith(20_000);
    expect([at.isError, at.text.length]).toEqual([false, 20_000]);
    const over = await callWith(20_001);
    expect([over.isError, over.text]).toEqual([true, expect.stringMatching(/^INTERNAL_ERROR: .*\(OverBudgetError\)/)]);
  });
});
