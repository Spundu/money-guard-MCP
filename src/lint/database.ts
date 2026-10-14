// Running the scripts in the worker thread (worker.js), with the time limits that keep a stuck or
// endless migration from holding the server (SPEC.md §3.4, §3.9). Resolves with the catalog's answers;
// rejects with a ToolError naming the file that failed, hung or ran out of time, or with a
// DatabaseStartError when the database could not start (not a ToolError: the server's own fault).

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
 * How much more memory the lint may take while the scripts run than it had once the database had
 * started (SPEC.md §3.9; measured by lintMemory). resourceLimits caps only the worker's JavaScript heap;
 * PGlite keeps its WebAssembly memory and its in-memory files outside it, so the process is watched.
 */
export const MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

/** How often the memory is checked. One statement can allocate more between two checks. */
const MEMORY_CHECK_MS = 100;

/**
 * The memory the lint can be blamed for: the database thread's own JavaScript heap and the memory
 * outside it that the thread holds (PGlite's WebAssembly memory and in-memory files), as Node.js 22.16
 * and later report for one thread, unmoved by a ledger or audit call on the main thread. Older Node.js
 * cannot measure one thread: the process's memory, less what the main thread's JavaScript holds, stands
 * in, and memory the main thread frees but the system keeps can then count against the lint.
 */
async function lintMemory(worker: Worker): Promise<number> {
  const thread = worker as Partial<Pick<Worker, 'getHeapStatistics'>>;
  if (thread.getHeapStatistics === undefined) {
    const m = process.memoryUsage();
    return m.rss - m.heapTotal - m.external;
  }
  const stats = await thread.getHeapStatistics.call(worker);
  return stats.total_heap_size + stats.external_memory;
}

/** A setup script (the preset or the setup file) fails as SETUP_FAILED, a migration as MIGRATION_FAILED. */
function failedCode(script: Script): 'SETUP_FAILED' | 'MIGRATION_FAILED' {
  return script.phase === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED';
}

/** The fix for a file that needs more than the database can give. The setup file is not one of the migrations, so files cannot leave it out. */
function tooBig(script: Script): string {
  const way = script.phase === 'setup' ? 'Take that part out of the setup file.' : 'Leave the file out with files, or lint the migrations in smaller groups.';
  return `The file needs more than the lint database can give it (memory or a size limit). ${way}`;
}

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
export function failure(script: Script, err: DbError, context: { available: readonly string[]; preset: boolean; filesGiven?: boolean }): ToolError {
  const code = failedCode(script);
  // The setup file runs before the migrations and is not one of them: its advice is to change it.
  const setup = script.phase === 'setup';
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
      `PGlite does not have that extension. It has: ${context.available.join(', ')}. If the file uses it for something unrelated to money, ${setup ? 'take that part out of the setup file' : 'leave the file out with files'}. ` +
      'A whole-database dump (pg_dump, supabase db dump) also creates the extensions a platform provides: lint the migrations folder instead (supabase/migrations for Supabase).';
  } else if (err.code === '42883' && err.message.startsWith('operator does not exist')) {
    fix = 'The two sides of an operator have types that do not go together (uuid and text, say): cast one side, or fix the column type.';
  } else if (setup && err.code !== undefined && MISSING_OBJECT.has(err.code)) {
    fix = context.preset
      ? 'The Supabase preset does not create this: create it earlier in the setup file.'
      : 'The setup file runs before the migrations: create what it needs earlier in the same file, or, for a Supabase project, call again with preset "supabase".';
  } else if (err.code !== undefined && MISSING_OBJECT.has(err.code)) {
    // A missing table or function is often one of the project's own, created by a file that sorts later
    // (Flyway's R__ files sort before V1__): say that first.
    const ran = context.filesGiven
      ? 'the files ran in the order files gives; put the file that creates it first. '
      : 'money-guard runs them in natural order of their paths; pass files to give the order your tool uses. ';
    const order = err.code === '42P01' || err.code === '42883' ? `If one of your migrations creates it, the files ran out of order: ${ran}` : '';
    fix =
      order +
      (context.preset
        ? 'The Supabase preset does not create this. Pass setup: a .sql file that creates it (it runs after the preset).'
        : 'This file needs objects your platform creates. For a Supabase project call again with preset "supabase"; otherwise pass setup: a .sql file that creates them (CREATE ROLE ..., CREATE SCHEMA ...).');
  } else if (err.code === '42601' && at !== null && (lines[at.line - 1] ?? '').startsWith('\\')) {
    fix = `That line is a psql meta-command, which only psql understands. ${setup ? 'Take it out of the setup file.' : 'Leave the file out with files, or lint a copy without that line.'}`;
  } else if (err.code === '42601' && at !== null && lines.slice(0, at.line - 1).some((line) => /^COPY\s.+\sFROM\s+stdin;/i.test(line))) {
    // pg_dump writes table rows after "COPY ... FROM stdin;" lines; only psql can feed them in.
    fix = `The file holds table data after COPY ... FROM stdin (a pg_dump with data), which only psql can load. ${setup ? 'Take the data out of the setup file.' : 'Lint a schema-only dump (pg_dump --schema-only) or the migrations folder instead.'}`;
  } else if (err.code === '25001') {
    const statement = /^(.+?) cannot run inside a transaction block$/.exec(err.message)?.[1] ?? 'this statement';
    fix = `money-guard runs each file as one script, where ${clip(statement, 60)} cannot run (psql, which commits statement by statement, can). ${setup ? 'Take it out of the setup file.' : 'If the file does nothing else, leave it out with files.'}`;
  } else if (err.code === '0A000' && /^cannot alter type of a column used (?:by|in) /.test(err.message)) {
    fix = 'Something else uses this column (a view, a rule, a policy, a trigger or a generated column): in the same migration, drop it before the ALTER and create it again after.';
  } else if (err.code === '55P04') {
    fix = `money-guard runs each file as one transaction, and a new enum value cannot be used in the transaction that adds it (psql, which commits statement by statement, can). ${setup ? 'Take that part out of the setup file.' : 'Split the file in two, or leave it out with files.'}`;
  } else if (err.code !== undefined && /^5[34]/.test(err.code)) {
    fix = tooBig(script);
  } else if (setup) {
    fix = 'Fix the setup file at that place.';
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
  options: { timeoutMs: number; preset: boolean; filesGiven?: boolean | undefined; signal?: AbortSignal | undefined; worker?: URL | undefined; memoryLimitBytes?: number | undefined; sanityMs?: number | undefined },
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
    let answered = -1; // the last step whose check after the file came back
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
      const fix = script.phase === 'setup' ? 'Take the statement that stops the database out of the setup file.' : 'Leave the file out with files, or lint it on its own to find the statement that stops the database.';
      return new ToolError(failedCode(script), `${script.name}: the database stopped while running this file (${clip(why, 200)}).`, fix);
    };
    // After a statement PGlite cannot carry out (COPY ... PROGRAM), the database answers wrongly or not at all.
    const stuck = (step: number, what: string): ToolError => {
      const script = scriptAt(step);
      const fix = script.phase === 'setup' ? 'Take that statement out of the setup file.' : 'Leave the file out with files.';
      return new ToolError(failedCode(script), `${script.name}: after this file the database ${what} (a statement PGlite cannot carry out, such as COPY ... PROGRAM).`, fix);
    };

    const memoryLimit = options.memoryLimitBytes ?? MEMORY_LIMIT_BYTES;
    let baseline: number | undefined; // the lint's memory once the database had started
    let measuring = false; // one measurement at a time
    const memory = setInterval(() => {
      if (baseline === undefined || measuring) return;
      measuring = true;
      lintMemory(worker).then(
        (used) => {
          measuring = false;
          if (baseline === undefined || used - baseline <= memoryLimit) return;
          const script = scriptAt(Math.max(running, 0));
          finish({ error: new ToolError(failedCode(script), `${script.name}: the lint database grew by more than ${formatMib(memoryLimit)} of memory while running this file.`, tooBig(script)) });
        },
        () => {
          measuring = false; // the thread has just ended: its own exit says why
        },
      );
    }, MEMORY_CHECK_MS);

    const overall = setTimeout(() => {
      const name = running >= 0 ? scriptAt(running).name : 'the database start-up';
      finish({ error: new ToolError('TIMEOUT', `The lint ran out of time (${options.timeoutMs / 1000} s) while running ${name}.`, 'Leave slow data-loading files out with files. A larger timeout_seconds (at most 300) helps only with a client that waits longer than 60 seconds for an answer.') });
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
          lintMemory(worker).then(
            (used) => {
              baseline ??= used;
            },
            () => {},
          );
          break;
        case 'running':
          running = m.step;
          break;
        case 'executed':
          sanity = setTimeout(() => {
            // The main thread may have been busy (a ledger or audit call) while the answer waited in the
            // queue: give a waiting message one turn of the event loop before calling the database stuck.
            setImmediate(() => {
              if (answered < m.step) finish({ error: stuck(m.step, 'stopped answering') });
            });
          }, options.sanityMs ?? SANITY_MS);
          break;
        case 'snapshot': {
          clearTimeout(sanity);
          answered = m.step;
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
          finish({ error: failure(scriptAt(m.step), m.error, { available, preset: options.preset, filesGiven: options.filesGiven ?? false }) });
          break;
        case 'unusable':
          finish({ error: stuck(m.step, 'no longer answers correctly') });
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
