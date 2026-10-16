// The MCP server: one factory that builds the server with its three tools (SPEC.md §2). The same
// factory serves both protocol eras (index.ts hands it to serveStdio) and the in-process tests.

import { createRequire } from 'node:module';
import { McpServer, SdkError, SdkErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { verifyAuditLog } from './audit/verify.js';
import type { Config } from './config.js';
import { MAX_RESULT_CHARS } from './budget.js';
import { clipPath, escapeHidden, escapeStrings } from './echo.js';
import { ToolError } from './errors.js';
import { checkLedgerFile } from './ledger/run.js';
import { lintSchema, refuseWhileLinting } from './lint/run.js';
import { logLine } from './log.js';
import { readChecked, resolveInRoot, type Root } from './paths.js';
import { auditInput, auditOutput, ledgerInput, ledgerOutput, lintInput, lintOutput } from './schemas.js';
import { AUDIT_DESCRIPTION, INSTRUCTIONS, LEDGER_DESCRIPTION, LINT_DESCRIPTION } from './text.js';

export const NAME = 'money-guard-mcp';
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** Every tool only reads, and only the project folder (SPEC.md §2.7). */
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const AUDIT_MAX_BYTES = 100 * 1024 * 1024;

export type Log = (line: string) => void;
const stderrLog: Log = logLine;

/** A result over the budget: each tool keeps within it (SPEC.md §2.4), so this is a bug, never sent. */
class OverBudgetError extends Error {
  override name = 'OverBudgetError';
}

/** null and undefined both mean "not given" (SPEC.md §2.4). */
function given<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/**
 * An unexpected error, for the log: its type, its error code and the code locations it came from, as
 * file:line:column only, then the same for its cause. Never its message, which might quote a file, and
 * never a folder: the location is taken from the end of each frame, so folder names with spaces or
 * brackets cannot leave words behind.
 */
export function trace(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return typeof err;
  // The stack starts with the message, which may span lines that look like frames: skip them all.
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(err.message.split('\n').length)
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, 4)
    .map((line) => /([^\\/\s()]+:\d+:\d+)\)?\s*$/.exec(line)?.[1] ?? '?');
  // An error code (EBUSY, ERR_MODULE_NOT_FOUND) says what failed and quotes nothing.
  const code = (err as { code?: unknown }).code;
  const head = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `${err.name} ${code}` : err.name;
  const line = [head, ...frames].join(' | ');
  return err.cause instanceof Error && depth < 2 ? `${line} <- ${trace(err.cause, depth + 1)}` : line;
}

/** How a call the client gave up on is logged: it gets no answer (the SDK drops it), whatever the tool did. */
function gaveUp(signal: AbortSignal): string {
  return signal.reason instanceof SdkError && signal.reason.code === SdkErrorCode.ConnectionClosed ? 'DISCONNECTED' : 'CANCELLED';
}

async function answer(tool: string, log: Log, signal: AbortSignal | undefined, work: () => Promise<object> | object): Promise<CallToolResult> {
  const started = performance.now();
  const ms = () => `${Math.round(performance.now() - started)}ms`;
  try {
    // The SDK reads the messages that came with this call before it runs, so a cancel sent right behind
    // it is already in: the call does not run (a ledger or audit check cannot be stopped once it has
    // started, SPEC.md §2.6).
    if (signal?.aborted) throw signal.reason;
    // Every string escaped once more on the way out (SPEC.md §2.4): a field a tool forgot cannot arrive raw.
    const result = escapeStrings(await work());
    const text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) throw new OverBudgetError(); // the last guard, should a tool's own fail
    log(`${NAME}: ${tool} ${signal?.aborted ? gaveUp(signal) : 'ok'} ${ms()}`);
    return { content: [{ type: 'text', text }], structuredContent: result as Record<string, unknown> };
  } catch (err) {
    if (signal?.aborted) {
      log(`${NAME}: ${tool} ${gaveUp(signal)} ${ms()}`);
      throw err; // the client is no longer waiting for an answer
    }
    if (err instanceof ToolError) {
      log(`${NAME}: ${tool} ${err.code} ${ms()}`);
      return { content: [{ type: 'text', text: escapeHidden(err.toText()) }], isError: true };
    }
    log(`${NAME}: ${tool} INTERNAL_ERROR ${ms()} ${trace(err)}`);
    const internal = new ToolError('INTERNAL_ERROR', `money-guard failed unexpectedly (${err instanceof Error ? err.name : typeof err}).`, internalFix(err));
    return { content: [{ type: 'text', text: escapeHidden(internal.toText()) }], isError: true };
  }
}

/** The fix for an unexpected failure: a lint database that cannot start is most often a broken install. */
export function internalFix(err: unknown): string {
  return err instanceof Error && err.name === 'DatabaseStartError'
    ? 'The lint database could not start, as after a broken install: reinstall money-guard (npm ci, or install the bundle again), and report it if that does not help. The server log has the details.'
    : 'This is a bug in money-guard: please report it. The server log has the details.';
}

export function createServer(config: Config, log: Log = stderrLog): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    // The tool list never changes (SPEC.md §2.7): say so, as the SDK would otherwise advertise listChanged,
    // and let a 2026-era client keep it a day (review round 17: it was sent as ttlMs 0, private).
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, maxToolInputElements: 2500, cacheHints: { 'tools/list': { ttlMs: 86_400_000, cacheScope: 'public' } } },
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
            offset: given(args.offset),
          },
          ctx.mcpReq.signal,
        ),
      ),
  );

  server.registerTool(
    'money_check_double_entry',
    { title: 'Check double-entry balance', description: LEDGER_DESCRIPTION, inputSchema: ledgerInput, outputSchema: ledgerOutput, annotations: ANNOTATIONS },
    async (args, ctx) =>
      answer('money_check_double_entry', log, ctx.mcpReq.signal, () => {
        refuseWhileLinting();
        return checkLedgerFile(root(), {
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
        });
      }),
  );

  server.registerTool(
    'audit_verify_chain',
    { title: 'Verify audit log chain', description: AUDIT_DESCRIPTION, inputSchema: auditInput, outputSchema: auditOutput, annotations: ANNOTATIONS },
    async (args, ctx) =>
      answer('audit_verify_chain', log, ctx.mcpReq.signal, () => {
        refuseWhileLinting();
        const target = resolveInRoot(root(), args.file, { kind: 'file', extensions: ['.jsonl', '.ndjson', '.log'], maxBytes: AUDIT_MAX_BYTES });
        if (!config.auditKeys.ok) throw config.auditKeys.error;
        return verifyAuditLog({ file: clipPath(target.rel), bytes: readChecked(target.real, target.rel), keys: config.auditKeys.value, anchor: given(args.anchor) });
      }),
  );

  return server;
}
