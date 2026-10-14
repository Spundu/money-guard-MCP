// The server through a real MCP client, in-process, in both protocol eras (SPEC.md §7): the 2026-07-28
// era pinned, and the 2025 era's initialize handshake. createMcpHandler serves the same factory that
// index.ts hands to serveStdio; test/stdio.test.ts covers the real stdio process.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { resolveConfig, type Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { AUDIT_DESCRIPTION, INSTRUCTIONS, LEDGER_DESCRIPTION, LINT_DESCRIPTION } from '../src/text.js';

type Era = 'modern' | 'legacy';
const ERAS: Era[] = ['modern', 'legacy'];
const CONFIG = resolveConfig({ MONEY_GUARD_ROOT: SHOP, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, SHOP);

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function connect(era: Era, config: Config = CONFIG): Promise<Client> {
  const handler = createMcpHandler(() => createServer(config, () => {}));
  const transport = new StreamableHTTPClientTransport(new URL('http://money-guard.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'money-guard-tests', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await client.connect(transport);
  open.push(async () => {
    await client.close();
    await handler.close();
  });
  return client;
}

type Result = Awaited<ReturnType<Client['callTool']>>;
const textOf = (r: Result) => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');

const JOURNAL_ARGS = { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'currency' } };

describe.each(ERAS)('the server, %s era', (era) => {
  it('negotiates the era it was asked for', async () => {
    const client = await connect(era);
    expect(client.getProtocolEra()).toBe(era);
  });

  it('gives the server instructions of SPEC.md §2.7', async () => {
    expect((await connect(era)).getInstructions()).toBe(INSTRUCTIONS);
  });

  it('lists the three tools in a fixed order, read-only, with the texts of SPEC.md', async () => {
    const { tools } = await (await connect(era)).listTools();
    expect(tools.map((t) => [t.name, t.title, t.description])).toEqual([
      ['money_lint_schema', 'Lint money column types', LINT_DESCRIPTION],
      ['money_check_double_entry', 'Check double-entry balance', LEDGER_DESCRIPTION],
      ['audit_verify_chain', 'Verify audit log chain', AUDIT_DESCRIPTION],
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('runs every tool on the demo project, with the same JSON as text and as structured content', async () => {
    const client = await connect(era);
    const results = [
      await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } }),
      await client.callTool({ name: 'money_check_double_entry', arguments: JOURNAL_ARGS }),
      await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } }),
      await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit-tampered.jsonl' } }),
    ];
    expect(results.map((r) => (r.structuredContent as { summary: string }).summary)).toEqual([
      '2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.',
      'Not balanced: 3 errors and 1 warning. 4 transactions: 2 balanced, 1 unbalanced, 1 not checked (rows with unreadable values).',
      'The log verifies: 2 entries, every seal and link intact. Keep head and pass it as anchor next time.',
      'The log does NOT verify: entry 0 (line 1) was edited after it was sealed (CONTENT_TAMPERED).',
    ]);
    for (const r of results) {
      expect(r.isError ?? false).toBe(false);
      expect(JSON.parse(textOf(r))).toEqual(r.structuredContent);
      expect(textOf(r).length).toBeLessThanOrEqual(20_000);
      expect(textOf(r)).not.toContain(FIXTURE_KEY_HEX.slice(0, 16));
    }
  });

  it('answers a problem the model can fix with an isError result that starts with the code', async () => {
    const client = await connect(era);
    const r = await client.callTool({ name: 'money_check_double_entry', arguments: { ...JOURNAL_ARGS, file: '../outside.csv' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^PATH_OUTSIDE_ROOT: "\.\.\/outside\.csv" is outside the project folder \(shop\)\. Fix: /);
    expect(r.structuredContent).toBeUndefined();
  });

  it('refuses arguments the schema does not allow, including unknown ones', async () => {
    const client = await connect(era);
    const unknown = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl', key: 'k1=00' } });
    expect([unknown.isError, textOf(unknown)]).toEqual([true, expect.stringMatching(/^Input validation error: /)]);
    const tooMany = await client.callTool({ name: 'money_check_double_entry', arguments: { ...JOURNAL_ARGS, limit: 500 } });
    expect(tooMany.isError).toBe(true);
  });

  it('treats null as "not given" for every optional argument', async () => {
    const client = await connect(era);
    const lint = await client.callTool({
      name: 'money_lint_schema',
      arguments: { migrations: 'db/migrations', files: null, preset: null, setup: null, accept_numeric: null, money_columns: null, ignore_columns: null, timeout_seconds: null },
    });
    expect((lint.structuredContent as { error_count: number }).error_count).toBe(1);
    const ledger = await client.callTool({
      name: 'money_check_double_entry',
      arguments: { ...JOURNAL_ARGS, columns: { ...JOURNAL_ARGS.columns, side: null, debit: null, credit: null }, amount_format: null, decimal_places: null, format: null, delimiter: null, records_pointer: null, offset: null, limit: null },
    });
    expect((ledger.structuredContent as { error_count: number }).error_count).toBe(3);
    const audit = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl', anchor: null } });
    expect((audit.structuredContent as { ok: boolean }).ok).toBe(true);
  });
});

describe('the server with bad settings', () => {
  it('answers ROOT_INVALID from every tool when the project folder is unusable, and keeps serving', async () => {
    const client = await connect('modern', resolveConfig({ MONEY_GUARD_ROOT: `${SHOP}-does-not-exist` }, SHOP));
    for (const [name, args] of [
      ['money_lint_schema', { migrations: 'db/migrations' }],
      ['money_check_double_entry', JOURNAL_ARGS],
      ['audit_verify_chain', { file: 'logs/audit.jsonl' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(/^ROOT_INVALID: /)]);
    }
  });

  it('answers KEYS_NOT_CONFIGURED from the audit tool only', async () => {
    const client = await connect('modern', resolveConfig({ MONEY_GUARD_ROOT: SHOP }, SHOP));
    const audit = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } });
    expect(textOf(audit)).toMatch(/^KEYS_NOT_CONFIGURED: /);
    const ledger = await client.callTool({ name: 'money_check_double_entry', arguments: JOURNAL_ARGS });
    expect(ledger.isError ?? false).toBe(false);
  });
});

/** Every `type` keyword in a JSON Schema, with where it is. */
function typeKeywords(node: unknown, at = '#'): Array<[string, unknown]> {
  if (node === null || typeof node !== 'object') return [];
  const here: Array<[string, unknown]> = 'type' in node ? [[at, (node as { type: unknown }).type]] : [];
  return [...here, ...Object.entries(node).flatMap(([k, v]) => typeKeywords(v, `${at}/${k}`))];
}

describe('the advertised schemas', () => {
  it('never use a type array, which some clients cannot read (Inspector --strict warns)', async () => {
    const { tools } = await (await connect('modern')).listTools();
    const arrays = tools.flatMap((t) => typeKeywords({ in: t.inputSchema, out: t.outputSchema }, t.name).filter(([, type]) => Array.isArray(type)));
    expect(arrays).toEqual([]);
  });
});

describe('the advertised input schemas', () => {
  it('fit what the Claude API accepts: an object root without combinators, strict, short plain property names', async () => {
    const { tools } = await (await connect('modern')).listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      for (const combinator of ['anyOf', 'oneOf', 'allOf']) expect(schema[combinator], `${tool.name} ${combinator}`).toBeUndefined();
      expect(schema.additionalProperties).toBe(false);
      for (const key of Object.keys(schema.properties as object)) expect(key).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
  });
});
