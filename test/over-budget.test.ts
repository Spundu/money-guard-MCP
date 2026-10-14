// The server's last guard (src/server.ts, SPEC.md §2.4): every tool keeps its result within 20,000
// characters, and should one ever fail to, the server still never sends it. The model gets
// INTERNAL_ERROR without detail and the log names the cause. The audit checker is replaced here by one
// that returns too much.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { resolveConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

vi.mock('../src/audit/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audit/verify.js')>()),
  verifyAuditLog: () => ({ summary: 'x'.repeat(25_000) }),
}));

describe('a result over the budget', () => {
  it('is never sent: the model gets INTERNAL_ERROR, and the log says why', async () => {
    const log: string[] = [];
    const config = resolveConfig({ MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, SHOP);
    const handler = createMcpHandler(() => createServer(config, (line) => log.push(line)));
    const client = new Client({ name: 'over-budget-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      const r = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } });
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect([r.isError, text]).toEqual([true, 'INTERNAL_ERROR: money-guard failed unexpectedly (OverBudgetError). Fix: This is a bug in money-guard: please report it. The server log has the details.']);
      expect(log.at(-1)).toMatch(/^money-guard-mcp: audit_verify_chain INTERNAL_ERROR \d+ms OverBudgetError/);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
