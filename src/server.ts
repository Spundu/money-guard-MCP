// The MCP server: one factory that builds the server with its three tools (SPEC.md §2). The same
// factory serves both protocol eras (index.ts hands it to serveStdio) and the in-process tests.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { verifyAuditLog } from './audit/verify.js';
import type { Config } from './config.js';
import { escapeStrings, escapeUnsafe } from './echo.js';
import { ToolError } from './errors.js';
import { checkLedgerFile } from './ledger/run.js';
import { lintSchema } from './lint/run.js';
import { resolveInRoot, type Root } from './paths.js';
import { auditInput, auditOutput, ledgerInput, ledgerOutput, lintInput, lintOutput } from './schemas.js';
import { AUDIT_DESCRIPTION, INSTRUCTIONS, LEDGER_DESCRIPTION, LINT_DESCRIPTION } from './text.js';

export const NAME = 'money-guard-mcp';
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Every tool only reads, and only the project folder (SPEC.md §2.7). */
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const AUDIT_MAX_BYTES = 100 * 1024 * 1024;

export type Log = (line: string) => void;
const stderrLog: Log = (line) => process.stderr.write(`${line}\n`);

/** null and undefined both mean "not given" (SPEC.md §2.4). */
function given<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * An unexpected error, for the log: its type and the code locations it came from, as file:line:column
 * only. Never its message, which might quote a file, and never a folder: the location is taken from the
 * end of each frame, so folder names with spaces or brackets cannot leave words behind.
 */
export function trace(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const frames = (err.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 4)
    .map((line) => /([^\\/\s()]+:\d+:\d+)\)?\s*$/.exec(line)?.[1] ?? '?');
  return [err.name, ...frames].join(' | ');
}

async function answer(tool: string, log: Log, signal: AbortSignal | undefined, work: () => Promise<object> | object): Promise<CallToolResult> {
  const started = performance.now();
  const ms = () => `${Math.round(performance.now() - started)}ms`;
  try {
    // Every string escaped once more on the way out (SPEC.md §2.4): a field a tool forgot cannot arrive raw.
    const result = escapeStrings(await work());
    log(`${NAME}: ${tool} ok ${ms()}`);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  } catch (err) {
    if (signal?.aborted) {
      log(`${NAME}: ${tool} CANCELLED ${ms()}`);
      throw err; // the client is no longer waiting for an answer
    }
    if (err instanceof ToolError) {
      log(`${NAME}: ${tool} ${err.code} ${ms()}`);
      return { content: [{ type: 'text', text: escapeUnsafe(err.toText()) }], isError: true };
    }
    log(`${NAME}: ${tool} INTERNAL_ERROR ${ms()} ${trace(err)}`);
    const internal = new ToolError('INTERNAL_ERROR', `money-guard failed unexpectedly (${err instanceof Error ? err.name : typeof err}).`, 'This is a bug in money-guard: please report it. The server log has the details.');
    return { content: [{ type: 'text', text: escapeUnsafe(internal.toText()) }], isError: true };
  }
}

export function createServer(config: Config, log: Log = stderrLog): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    // The tool list never changes (SPEC.md §2.7): say so, as the SDK would otherwise advertise listChanged.
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, maxToolInputElements: 2500 },
  );
  const root = (): Root => {
    if (!config.root.ok) throw config.root.error;
    return config.root.value;
  };

  server.registerTool(
    'money_lint_schema',
    { title: 'Lint money column types', description: LINT_DESCRIPTION, inputSchema: lintInput, outputSchema: lintOutput, annotations: ANNOTATIONS },
    async (args, ctx) =>
      answer('money_lint_schema', log, ctx.mcpReq.signal, () =>
        lintSchema(
          root(),
          {
            migrations: args.migrations,
            files: given(args.files),
            preset: given(args.preset),
            setup: given(args.setup),
            accept_numeric: given(args.accept_numeric),
            money_columns: given(args.money_columns),
            ignore_columns: given(args.ignore_columns),
            timeout_seconds: given(args.timeout_seconds),
          },
          ctx.mcpReq.signal,
        ),
      ),
  );

  server.registerTool(
    'money_check_double_entry',
    { title: 'Check double-entry balance', description: LEDGER_DESCRIPTION, inputSchema: ledgerInput, outputSchema: ledgerOutput, annotations: ANNOTATIONS },
    async (args, ctx) =>
      answer('money_check_double_entry', log, ctx.mcpReq.signal, () =>
        checkLedgerFile(root(), {
          file: args.file,
          columns: {
            transaction_id: args.columns.transaction_id,
            amount: given(args.columns.amount),
            side: given(args.columns.side),
            debit: given(args.columns.debit),
            credit: given(args.columns.credit),
            currency: given(args.columns.currency),
          },
          amount_format: given(args.amount_format),
          decimal_places: given(args.decimal_places),
          format: given(args.format),
          delimiter: given(args.delimiter),
          records_pointer: given(args.records_pointer),
          offset: given(args.offset),
          limit: given(args.limit),
        }),
      ),
  );

  server.registerTool(
    'audit_verify_chain',
    { title: 'Verify audit log chain', description: AUDIT_DESCRIPTION, inputSchema: auditInput, outputSchema: auditOutput, annotations: ANNOTATIONS },
    async (args, ctx) =>
      answer('audit_verify_chain', log, ctx.mcpReq.signal, () => {
        const target = resolveInRoot(root(), args.file, { kind: 'file', extensions: ['.jsonl', '.ndjson', '.log'], maxBytes: AUDIT_MAX_BYTES });
        if (!config.auditKeys.ok) throw config.auditKeys.error;
        return verifyAuditLog({ file: escapeUnsafe(target.rel), bytes: readFileSync(target.real), keys: config.auditKeys.value, anchor: given(args.anchor) });
      }),
  );

  return server;
}
