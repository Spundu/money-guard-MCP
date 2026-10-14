// A bug inside a tool (SPEC.md §2.1, §2.5): the model gets INTERNAL_ERROR with no detail, the server keeps
// serving, and the log gets the error's type and code locations only: never its message, which could
// quote a file, and never a folder name, which could be private. The ledger checker is replaced here by
// one that throws, with a stack whose folders hold spaces and brackets.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { SHOP } from '../scripts/fixtures.mjs';
import { resolveConfig } from '../src/config.js';
import { createServer, trace } from '../src/server.js';

vi.mock('../src/ledger/run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ledger/run.js')>()),
  checkLedgerFile: () => {
    const err = new TypeError('cannot read "STRIPE_SECRET_KEY=sk_test_1" from row 7');
    err.stack = [
      'TypeError: cannot read "STRIPE_SECRET_KEY=sk_test_1" from row 7',
      '    at checkLedgerFile (C:\\Users\\Jo Bloggs\\Payroll (2024) files\\money-guard\\dist\\ledger\\run.js:135:19)',
      '    at /home/jo/Client Payroll/money-guard/dist/server.js:120:7',
      '    at async Promise.all (index 0)',
    ].join('\n');
    throw err;
  },
}));

describe('a bug inside a tool', () => {
  it('answers INTERNAL_ERROR without detail, logs only the type and file:line, and keeps serving', async () => {
    const log: string[] = [];
    const handler = createMcpHandler(() => createServer(resolveConfig({ MONEY_GUARD_ROOT: SHOP }, SHOP), (line) => log.push(line)));
    const client = new Client({ name: 'internal-error-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      const r = await client.callTool({ name: 'money_check_double_entry', arguments: { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } });
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect([r.isError, text]).toEqual([true, 'INTERNAL_ERROR: money-guard failed unexpectedly (TypeError). Fix: This is a bug in money-guard: please report it. The server log has the details.']);
      expect(log.at(-1)).toMatch(/^money-guard-mcp: money_check_double_entry INTERNAL_ERROR \d+ms TypeError \| run\.js:135:19 \| server\.js:120:7 \| \?$/);
      for (const leak of ['STRIPE', 'sk_test', 'Bloggs', 'Payroll', 'Client', 'home', 'Users']) expect(log.join('\n')).not.toContain(leak);
      const after = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
      expect(after.isError ?? false).toBe(false);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it('describes something thrown that is not an Error by its type alone', () => {
    expect(trace('a string with secrets')).toBe('string');
    expect(trace({ secret: 1 })).toBe('object');
  });
});
