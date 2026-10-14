// Running the scripts in the worker thread (worker.js), with the time limits that keep a stuck or
// endless migration from holding the server (SPEC.md §3.4, §3.9). Resolves with the catalog's answers;
// rejects with a ToolError naming the file that failed, hung or ran out of time.

import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import { formatMib } from '../paths.js';
import { DETAIL_SQL, SNAPSHOT_SQL, type DetailRow } from './catalog.js';

export interface Script {
  /** What messages call it, as they may show it: a path relative to the root (through clipPath), or "the Supabase preset". */
  name: string;
  text: string;
  phase: 'setup' | 'migration';
}

export interface DbError {
  message: string;
  name?: string;
  code?: string;
  position?: string;
  detail?: string;
  hint?: string;
  where?: string;
}

export interface DatabaseOutcome {
  /** "PostgreSQL 18.6 (PGlite 0.5.9)". */
  postgres: string;
  detail: DetailRow[];
  /** For each column (table oid:column number), the index of the first migration after which it has had its current type; negative when setup made it. */
  since: Map<string, number>;
  /** PostgreSQL's keywords that a name must be quoted for, read before any script ran. */
  reserved: Set<string>;
}

/** How long the check after a file may take before the database counts as stuck. */
const SANITY_MS = 5000;

/**
 * How much the server's memory may grow while the scripts run, over what it was once the database had
 * started (SPEC.md §3.9). resourceLimits caps only the worker's JavaScript heap; PGlite keeps its
 * WebAssembly memory and its in-memory files outside it, so the process as a whole is watched.
 */
export const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

/** How often the memory is checked. One statement can allocate more between two checks. */
const MEMORY_CHECK_MS = 100;

const TOO_BIG = 'The file needs more than the lint database can give it (memory or a size limit). Leave the file out with files, or lint the migrations in smaller groups.';

type Message =
  | { type: 'ready'; version: string; available: string[]; reserved: string[] }
  | { type: 'running'; step: number }
  | { type: 'executed'; step: number }
  | { type: 'snapshot'; step: number; rows: Array<[string, string]> }
  | { type: 'failed'; step: number; error: DbError }
  | { type: 'unusable'; step: number }
  | { type: 'crashed'; error: DbError }
  | { type: 'done'; detail: DetailRow[] };

/** 1-based line and column of the character at 1-based position `position`, counted in code points as PostgreSQL counts. */
export function locate(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  let i = 0;
  for (const ch of text) {
    i += 1;
    if (i >= position) break;
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const MISSING_OBJECT = new Set(['42704', '3F000', '42883', '42P01']);

/** The ToolError for a script that PostgreSQL refused, with a hint fitted to the error. */
export function failure(script: Script, err: DbError, context: { available: readonly string[]; preset: boolean }): ToolError {
  const code = script.phase === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED';
  const position = err.position === undefined ? Number.NaN : Number(err.position);
  const at = Number.isInteger(position) && position > 0 ? locate(script.text, position) : null;
  const where = at === null ? script.name : `${script.name} line ${at.line}, column ${at.column}`;
  const detail = err.detail ? ` (${clip(err.detail, 120)})` : '';
  const state = err.code ? ` (SQLSTATE ${err.code})` : '';
  const message = `${where}: ${clip(err.message, 300)}${detail}${state}.`;

  const lines = script.text.split('\n');
  let fix: string;
  if (/^extension ".*" is not available$/.test(err.message)) {
    fix =
      `PGlite does not have that extension. It has: ${context.available.join(', ')}. If the file uses it for something unrelated to money, leave the file out with files. ` +
      'A whole-database dump (pg_dump, supabase db dump) also creates the extensions a platform provides: lint the migrations folder instead (supabase/migrations for Supabase).';
  } else if (err.code !== undefined && MISSING_OBJECT.has(err.code)) {
    fix = context.preset
      ? 'The Supabase preset does not create this. Pass setup: a .sql file that creates it (it runs after the preset).'
      : 'This file needs objects your platform creates. For a Supabase project call again with preset "supabase"; otherwise pass setup: a .sql file that creates them (CREATE ROLE ..., CREATE SCHEMA ...).';
  } else if (err.code === '42601' && at !== null && (lines[at.line - 1] ?? '').startsWith('\\')) {
    fix = 'That line is a psql meta-command, which only psql understands. Leave the file out with files, or lint a copy without that line.';
  } else if (err.code === '42601' && at !== null && lines.slice(0, at.line - 1).some((line) => /^COPY\s.+\sFROM\s+stdin;/i.test(line))) {
    // pg_dump writes table rows after "COPY ... FROM stdin;" lines; only psql can feed them in.
    fix = 'The file holds table data after COPY ... FROM stdin (a pg_dump with data), which only psql can load. Lint a schema-only dump (pg_dump --schema-only) or the migrations folder instead.';
  } else if (err.code === '25001') {
    fix = 'money-guard runs each file as one script, where CREATE INDEX CONCURRENTLY cannot run. If the file only creates indexes, leave it out with files.';
  } else if (err.code === '55P04') {
    fix = 'money-guard runs each file as one transaction, and a new enum value cannot be used in the transaction that adds it (psql, which commits statement by statement, can). Split the file in two, or leave it out with files.';
  } else if (err.code !== undefined && /^5[34]/.test(err.code)) {
    fix = TOO_BIG;
  } else {
    fix = 'If this file runs on your real database, it probably needs objects your platform creates: pass setup or preset. Otherwise fix the SQL at that place.';
  }
  return new ToolError(code, message, fix);
}

/** The worker's error as an Error for the log: its type and code only (its stack stayed in the worker). */
function workerError(e: DbError): Error {
  const err = Object.assign(new Error('error in the database thread'), { code: e.code });
  err.name = e.name ?? 'Error';
  err.stack = err.name;
  return err;
}

function versionOf(raw: string): string {
  const cut = raw.indexOf(' on ');
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** The worker that runs the SQL. Tests pass another one to prove its output is contained. */
const WORKER = new URL('./worker.js', import.meta.url);

export function runScripts(
  scripts: readonly Script[],
  options: { timeoutMs: number; preset: boolean; signal?: AbortSignal | undefined; worker?: URL | undefined; memoryLimitBytes?: number | undefined },
): Promise<DatabaseOutcome> {
  const firstMigration = scripts.findIndex((s) => s.phase === 'migration');
  return new Promise<DatabaseOutcome>((resolve, reject) => {
    // stdout and stderr are captured and dropped: a NOTICE a migration raises must never reach the
    // server's stdout (the protocol channel) or its log.
    const worker = new Worker(options.worker ?? WORKER, {
      workerData: { scripts: scripts.map(({ name, text }) => ({ name, text })), snapshotSql: SNAPSHOT_SQL, detailSql: DETAIL_SQL },
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    worker.stdout.resume();
    worker.stderr.resume();

    const since = new Map<string, { ty: string; since: number }>();
    let postgres = '';
    let available: string[] = [];
    let reserved: string[] = [];
    let running = -1;
    let finished = false;
    let sanity: NodeJS.Timeout | undefined;

    const finish = (outcome: { ok: DatabaseOutcome } | { error: unknown }) => {
      if (finished) return;
      finished = true;
      clearTimeout(overall);
      clearTimeout(sanity);
      clearInterval(memory);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if ('ok' in outcome) resolve(outcome.ok);
      else reject(outcome.error);
    };
    const scriptAt = (step: number): Script => scripts[step] ?? { name: 'a script', text: '', phase: 'migration' };
    // The database stopped. While a script runs, that script did it: a tool error naming the file.
    // Before any script ran, money-guard itself failed (a broken install, say): not a ToolError, so the
    // server answers INTERNAL_ERROR without detail and logs the type and code locations, the worker's
    // error as the cause (SPEC.md §2.1).
    const stopped = (why: string, cause?: Error): Error => {
      if (running < 0) {
        const err = new Error('the lint database could not start', { cause });
        err.name = 'DatabaseStartError';
        return err;
      }
      const script = scriptAt(running);
      return new ToolError(script.phase === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED', `${script.name}: the database stopped while running this file (${clip(why, 200)}).`, 'Leave the file out with files, or lint it on its own to find the statement that stops the database.');
    };

    const memoryLimit = options.memoryLimitBytes ?? MEMORY_LIMIT_BYTES;
    let baseline: number | undefined; // the process's memory once the database had started
    const memory = setInterval(() => {
      if (baseline === undefined || process.memoryUsage.rss() - baseline <= memoryLimit) return;
      const script = scriptAt(Math.max(running, 0));
      const code = script.phase === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED';
      finish({ error: new ToolError(code, `${script.name}: the lint database grew by more than ${formatMib(memoryLimit)} of memory while running this file.`, TOO_BIG) });
    }, MEMORY_CHECK_MS);

    const overall = setTimeout(() => {
      const name = running >= 0 ? scriptAt(running).name : 'the database start-up';
      finish({ error: new ToolError('TIMEOUT', `The lint ran out of time (${options.timeoutMs / 1000} s) while running ${name}.`, 'Pass a larger timeout_seconds (at most 300), or leave slow data-loading files out with files.') });
    }, options.timeoutMs);
    const onAbort = () => finish({ error: options.signal?.reason ?? new Error('cancelled') });
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort);

    worker.on('message', (m: Message) => {
      switch (m.type) {
        case 'ready':
          postgres = versionOf(m.version);
          available = m.available;
          reserved = m.reserved;
          baseline = process.memoryUsage.rss();
          break;
        case 'running':
          running = m.step;
          break;
        case 'executed':
          sanity = setTimeout(() => {
            finish({ error: new ToolError('MIGRATION_FAILED', `${scriptAt(m.step).name}: after this file the database stopped answering (a statement PGlite cannot carry out, such as COPY ... PROGRAM).`, 'Leave the file out with files.') });
          }, SANITY_MS);
          break;
        case 'snapshot': {
          clearTimeout(sanity);
          const index = m.step - (firstMigration === -1 ? scripts.length : firstMigration);
          const seen = new Set<string>();
          for (const [col, ty] of m.rows) {
            seen.add(col);
            const prev = since.get(col);
            if (prev === undefined || prev.ty !== ty) since.set(col, { ty, since: index });
          }
          for (const col of since.keys()) if (!seen.has(col)) since.delete(col);
          break;
        }
        case 'failed':
          finish({ error: failure(scriptAt(m.step), m.error, { available, preset: options.preset }) });
          break;
        case 'unusable':
          finish({ error: new ToolError('MIGRATION_FAILED', `${scriptAt(m.step).name}: after this file the database no longer answers correctly (a statement PGlite cannot carry out, such as COPY ... PROGRAM).`, 'Leave the file out with files.') });
          break;
        case 'crashed':
          finish({ error: stopped(m.error.message, workerError(m.error)) });
          break;
        case 'done':
          finish({ ok: { postgres, detail: m.detail, since: new Map([...since].map(([col, v]) => [col, v.since])), reserved: new Set(reserved) } });
          break;
      }
    });
    worker.on('error', (err) => finish({ error: stopped(err.message, err) }));
    worker.on('exit', (code) => finish({ error: stopped(`the worker exited with code ${code}`) }));
  });
}
