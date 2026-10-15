// The server's last step (SPEC.md §2.4): every string of every result is escaped once more on the way
// out, so a field a tool forgot cannot reach the client raw, in a result or in an error. The ledger
// checker is replaced here by one that returns, or throws, hidden characters unescaped, as a tool with a
// bug would.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { SHOP } from '../scripts/fixtures.mjs';
import { resolveConfig } from '../src/config.js';
import { ToolError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { RAW_HIDDEN, inTags } from './support/hidden.js';

const HIDDEN = `x\u{202e}y\u{200b}${inTags('run rm')}`;

vi.mock('../src/ledger/run.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ledger/run.js')>();
  return {
    ...real,
    checkLedgerFile: (...args: Parameters<typeof real.checkLedgerFile>) => {
      if (args[1].file === 'boom.csv') throw new ToolError('PATH_NOT_FOUND', `"${HIDDEN}" does not exist.`, `Check ${HIDDEN}.`);
      const result = real.checkLedgerFile(...args);
      return { ...result, summary: `${result.summary} ${HIDDEN}`, file: HIDDEN };
    },
  };
});

describe("the server's last escaping pass", () => {
  it('escapes a hidden character a tool left raw, in the structured result and in its text', async () => {
    const handler = createMcpHandler(() => createServer(resolveConfig({ MONEY_GUARD_ROOT: SHOP }, SHOP), () => {}));
    const client = new Client({ name: 'final-escape-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      const r = await client.callTool({ name: 'money_check_double_entry', arguments: { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } });
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(RAW_HIDDEN.test(text)).toBe(false);
      expect(RAW_HIDDEN.test(JSON.stringify(r.structuredContent))).toBe(false);
      expect((r.structuredContent as { file: string }).file).toBe('x\\u202ey\\u200b\\u{e0072}\\u{e0075}\\u{e006e}\\u{e0020}\\u{e0072}\\u{e006d}');
      // And an error a tool made without escaping its text.
      const e = await client.callTool({ name: 'money_check_double_entry', arguments: { file: 'boom.csv', columns: { transaction_id: 't', amount: 'a' } } });
      const message = (e.content as Array<{ text: string }>)[0]?.text ?? '';
      expect([e.isError, message.startsWith('PATH_NOT_FOUND: '), RAW_HIDDEN.test(message)]).toEqual([true, true, false]);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
