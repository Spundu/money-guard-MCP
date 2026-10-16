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
import { RAW_HIDDEN } from './support/hidden.js';
import { tempDir, writeTree } from './support/tmp.js';

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

  it('gives the server instructions of SPEC.md §2.7, and says its tool list never changes', async () => {
    const client = await connect(era);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
  });

  it('lists the three tools in a fixed order, read-only, with the texts of SPEC.md', async () => {
    const listed = await (await connect(era)).listTools();
    const { tools } = listed;
    // Review round 17: a list that never changes may be kept a day (2026-07-28 cache fields only).
    if (era === 'modern') expect([listed.ttlMs, listed.cacheScope]).toEqual([86_400_000, 'public']);
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
      expect(textOf(r)).toBe(JSON.stringify(r.structuredContent)); // compact: the size budget counts this text
      expect(textOf(r).length).toBeLessThanOrEqual(20_000);
      expect(textOf(r)).not.toContain(FIXTURE_KEY_HEX.slice(0, 16));
    }
  });

  it('passes offset to the lint, which gives the next findings and where the ones after start', async () => {
    // Review round 11: the lint has pages, as the ledger has.
    const client = await connect(era);
    const all = (await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } })).structuredContent as { findings: unknown[]; next_offset: number | null };
    const next = (await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations', offset: 1 } })).structuredContent as { findings: unknown[]; next_offset: number | null };
    expect(all.findings.length).toBeGreaterThan(1);
    expect([next.findings, next.next_offset]).toEqual([all.findings.slice(1), null]);
  });

  it('answers BUSY from the ledger and audit tools while a lint runs, so the lint memory check keeps running', async () => {
    // Review round 8: a ledger or audit call holds the main thread for seconds, and the lint's memory
    // limit is checked there: a hostile migration grew by gigabytes meanwhile.
    const client = await connect(era);
    const lint = client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
    const busy = await Promise.all([
      client.callTool({ name: 'money_check_double_entry', arguments: JOURNAL_ARGS }),
      client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } }),
    ]);
    expect(busy.map((r) => [r.isError, textOf(r).split(':')[0]])).toEqual([[true, 'BUSY'], [true, 'BUSY']]);
    // Refused, not queued (review round 9): a model must call again, not wait for an answer.
    expect(textOf(busy[0] ?? { content: [] })).toMatch(/^BUSY: A schema lint is running; this check is refused until it ends, /);
    expect((await lint).isError ?? false).toBe(false);
    expect((await client.callTool({ name: 'money_check_double_entry', arguments: JOURNAL_ARGS })).isError ?? false).toBe(false); // free again
  });

  it('answers a problem the model can fix with an isError result that starts with the code', async () => {
    const client = await connect(era);
    const r = await client.callTool({ name: 'money_check_double_entry', arguments: { ...JOURNAL_ARGS, file: '../outside.csv' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^PATH_OUTSIDE_ROOT: "\.\.\/outside\.csv" is outside the project folder "shop"\. Fix: /); // in quotes (review round 17)
    expect(r.structuredContent).toBeUndefined();
  });

  it('refuses arguments the schema does not allow, including unknown ones', async () => {
    const client = await connect(era);
    const unknown = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl', key: 'k1=00' } });
    expect([unknown.isError, textOf(unknown)]).toEqual([true, expect.stringMatching(/^Input validation error: /)]);
    const tooMany = await client.callTool({ name: 'money_check_double_entry', arguments: { ...JOURNAL_ARGS, limit: 500 } });
    expect(tooMany.isError).toBe(true);
    // A records pointer is repeated in every location of a JSON finding, so it is kept short.
    const longPointer = await client.callTool({ name: 'money_check_double_entry', arguments: { ...JOURNAL_ARGS, records_pointer: `/${'p'.repeat(256)}` } });
    expect([longPointer.isError, textOf(longPointer)]).toEqual([true, expect.stringMatching(/^Input validation error: /)]);
    // Nested objects are strict too, a time limit has a floor, and a JSON Pointer must be valid.
    for (const args of [
      { ...JOURNAL_ARGS, columns: { ...JOURNAL_ARGS.columns, currncy: 'currency' } },
      { ...JOURNAL_ARGS, columns: { ...JOURNAL_ARGS.columns, amount: '/a~2' } },
    ]) {
      const r = await client.callTool({ name: 'money_check_double_entry', arguments: args });
      expect([r.isError, textOf(r)], JSON.stringify(args)).toEqual([true, expect.stringMatching(/^Input validation error: /)]);
    }
    const tooShort = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations', timeout_seconds: 4 } });
    expect([tooShort.isError, textOf(tooShort)]).toEqual([true, expect.stringMatching(/^Input validation error: /)]);
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

describe('the audit log size limit', () => {
  it('refuses a log over 100 MiB before reading it, and takes one of exactly 100 MiB', async () => {
    const dir = tempDir();
    writeTree(dir, { 'logs/over.jsonl': Buffer.alloc(100 * 1024 * 1024 + 1, 0x20), 'logs/at.jsonl': Buffer.alloc(100 * 1024 * 1024, 0x20) });
    const client = await connect('modern', resolveConfig({ MONEY_GUARD_ROOT: dir, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, dir));
    const over = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/over.jsonl' } });
    expect([over.isError, textOf(over)]).toEqual([true, expect.stringMatching(/^FILE_TOO_LARGE: /)]);
    const at = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/at.jsonl' } });
    expect(at.isError ?? false).toBe(false); // read and verified (it is not a valid log, which is a result, not an error)
  });
});

describe('a long files list', () => {
  it('passes the input-element limit with room to spare (up to 2,000 files)', async () => {
    const dir = tempDir();
    const files = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, '0')}.sql`);
    writeTree(dir, Object.fromEntries(files.map((f) => [`db/migrations/${f}`, 'select 1;'])));
    const client = await connect('modern', resolveConfig({ MONEY_GUARD_ROOT: dir }, dir));
    const r = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations', files } });
    expect([r.isError ?? false, (r.structuredContent as { files_applied_count: number }).files_applied_count]).toEqual([false, 300]);
  });
});

describe('a hostile project', () => {
  it('never sends a control or invisible character raw, in a result or in an error (SPEC.md §2.4)', async () => {
    // In folder names, file names, table and column names, ids and currencies: U+202E (right-to-left
    // override, the "Trojan Source" trick for making text read differently from what it is), a
    // zero-width space and a TAG character (text a person cannot see but a model reads).
    const RLO = '\u{202e}\u{200b}\u{e0041}';
    const dir = tempDir();
    writeTree(dir, {
      [`db/${RLO}ok/0001_${RLO}a.sql`]: `create table o ("total_${RLO}x" double precision);`,
      [`db/${RLO}bad/0001_${RLO}b.sql`]: 'create table broken (;',
      [`db/${RLO}none/notes.txt`]: 'not sql',
      [`exports/${RLO}j.csv`]: `t,a,c\nT${RLO}1,5,GBP${RLO}\nT${RLO}1,-4,GBP${RLO}\n`,
      [`logs/${RLO}a.jsonl`]: '{"x":1}\n',
    });
    const client = await connect('modern', resolveConfig({ MONEY_GUARD_ROOT: dir, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, dir));
    const outcomes: string[] = [];
    for (const [name, args] of [
      ['money_lint_schema', { migrations: `db/${RLO}ok` }],
      ['money_lint_schema', { migrations: `db/${RLO}bad` }],
      ['money_lint_schema', { migrations: `db/${RLO}none` }],
      ['money_check_double_entry', { file: `exports/${RLO}j.csv`, columns: { transaction_id: 't', amount: 'a', currency: 'c' } }],
      ['audit_verify_chain', { file: `logs/${RLO}a.jsonl` }],
      ['money_check_double_entry', { file: `exports/${RLO}missing.csv`, columns: { transaction_id: 't', amount: 'a' } }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      outcomes.push(r.isError ? textOf(r).replace(/:.*$/s, '') : 'ok');
      expect(RAW_HIDDEN.test(textOf(r)), `${name} ${JSON.stringify(args)}`).toBe(false);
      expect(RAW_HIDDEN.test(JSON.stringify(r.structuredContent ?? null)), name).toBe(false);
      // The server's last pass leaves the tools' escapes as they are: one backslash, never two.
      const all = textOf(r) + JSON.stringify(r.structuredContent ?? null);
      expect(all, name).toContain('u202e');
      expect(all, name).not.toContain(`${'\\'.repeat(4)}u202e`); // two backslashes, as JSON writes them
    }
    expect(outcomes).toEqual(['ok', 'MIGRATION_FAILED', 'NO_SQL_FILES', 'ok', 'ok', 'PATH_NOT_FOUND']);
  });

  it('cuts a long audit log path in the middle, as every result does (test/shown-paths.test.ts)', async () => {
    const dir = tempDir();
    const deep = Array.from({ length: 4 }, () => 'a'.repeat(120)).join('/');
    writeTree(dir, { [`${deep}/audit.jsonl`]: '' });
    const client = await connect('legacy', resolveConfig({ MONEY_GUARD_ROOT: dir, MONEY_GUARD_AUDIT_KEYS: `k1=${FIXTURE_KEY_HEX}` }, dir));
    const r = await client.callTool({ name: 'audit_verify_chain', arguments: { file: `${deep}/audit.jsonl` } });
    const file = (r.structuredContent as { file: string }).file;
    expect([...file].length).toBeLessThanOrEqual(400);
    expect(file).toMatch(/^[a/]+…[a/]+\/audit\.jsonl$/);
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
