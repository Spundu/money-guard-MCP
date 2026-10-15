// Running the scripts in the worker thread (worker.js), with the time limits that keep a stuck or
// endless migration from holding the server (SPEC.md §3.4, §3.9). Resolves with the catalog's answers;
// rejects with a ToolError naming the file that failed, hung or ran out of time, or with a
// DatabaseStartError when the database could not start (not a ToolError: the server's own fault).

import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import { failedCode, failure, tooBig, wayPast } from './advice.js';
import { formatMib } from '../paths.js';
import { DETAIL_SQL, MARK_SQL, SNAPSHOT_SQL, type DetailRow } from './catalog.js';

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

type Message =
  | { type: 'ready'; version: string; available: string[]; reserved: string[] }
  | { type: 'running'; step: number }
  | { type: 'executed'; step: number }
  | { type: 'snapshot'; step: number; rows: Array<[string, string]> }
  | { type: 'reading' }
  | { type: 'failed'; step: number; error: DbError }
  | { type: 'unusable'; step: number }
  | { type: 'crashed'; error: DbError }
  | { type: 'done'; detail: DetailRow[] };

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

export interface RunOptions {
  timeoutMs: number;
  preset: boolean;
  filesGiven?: boolean | undefined;
  /** migrations names one file, which files cannot pick from. */
  single?: boolean | undefined;
  signal?: AbortSignal | undefined;
  worker?: URL | undefined;
  memoryLimitBytes?: number | undefined;
  sanityMs?: number | undefined;
}

/**
 * Settles once the last database thread started has ended. The next one starts only then: on Node.js
 * 24, a thread that starts while another is being torn down can make V8 abort the whole process
 * (nodejs/node#66366, fixed in V8 but not yet in a Node.js 24 release). A thread ends within a fraction
 * of a second of being told to, and its lint has answered by then: JavaScript and WebAssembly stop at
 * their next check, and the database thread makes no blocking calls (an endless loop and pg_sleep both
 * end at once, test/lint-failures.test.ts).
 */
let lastThread: Promise<unknown> = Promise.resolve();

export function runScripts(scripts: readonly Script[], options: RunOptions): Promise<DatabaseOutcome> {
  const previous = lastThread;
  let ended = () => {};
  lastThread = new Promise<void>((resolve) => (ended = resolve));
  const calledAt = Date.now();
  return waitForThread(previous, options).then(
    () => startScripts(scripts, options, ended, calledAt),
    (err: unknown) => {
      void previous.then(ended); // no thread of its own: the next lint still waits for the last one
      throw err;
    },
  );
}

/**
 * Settles when `previous` has ended. The lint's time limit and its cancellation count from the call,
 * so a thread that never ended would cost the next lint a TIMEOUT, not a hang.
 */
function waitForThread(previous: Promise<unknown>, options: RunOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (settle: () => void) => {
      clearTimeout(limit);
      options.signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const limit = setTimeout(
      () =>
        done(() =>
          reject(new ToolError('TIMEOUT', `The lint ran out of time (${options.timeoutMs / 1000} s) while starting the database.`, 'A larger timeout_seconds (at most 300) helps only with a client that waits longer than 60 seconds for an answer.')),
        ),
      options.timeoutMs,
    );
    const onAbort = () => done(() => reject(options.signal?.reason ?? new Error('cancelled')));
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort);
    void previous.then(() => done(resolve));
  });
}

/**
 * Runs the scripts in a new database thread, and calls `ended` once that thread has ended. The time
 * limit counts from `calledAt`, when the lint asked for its thread.
 */
function startScripts(scripts: readonly Script[], options: RunOptions, ended: () => void, calledAt: number): Promise<DatabaseOutcome> {
  const firstMigration = scripts.findIndex((s) => s.phase === 'migration');
  return new Promise<DatabaseOutcome>((resolve, reject) => {
    // stdout and stderr are captured and dropped: a NOTICE a migration raises must never reach the
    // server's stdout (the protocol channel) or its log.
    let worker: Worker;
    try {
      worker = new Worker(options.worker ?? WORKER, {
        workerData: { scripts: scripts.map(({ name, text }) => ({ name, text })), markSql: MARK_SQL, snapshotSql: SNAPSHOT_SQL, detailSql: DETAIL_SQL },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      });
    } catch (err) {
      ended(); // no thread started
      throw err;
    }
    worker.stdout.resume();
    worker.stderr.resume();

    const since = new Map<string, { ty: string; since: number }>();
    let postgres = '';
    let available: string[] = [];
    let reserved: string[] = [];
    let running = -1;
    let answered = -1; // the last step whose check after the file came back
    let reading = false; // every script has run, and the catalog is being read
    let finished = false;
    let sanity: NodeJS.Timeout | undefined;

    const finish = (outcome: { ok: DatabaseOutcome } | { error: unknown }) => {
      if (finished) return;
      finished = true;
      clearTimeout(overall);
      clearTimeout(sanity);
      clearInterval(memory);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate().then(ended, ended);
      if ('ok' in outcome) resolve(outcome.ok);
      else reject(outcome.error);
    };
    const scriptAt = (step: number): Script => scripts[step] ?? { name: 'a script', text: '', phase: 'migration' };
    // The database stopped. While a script runs, that script did it: a tool error naming the file.
    // Once every file has run, reading the catalog failed: a tool error naming the last file, since a
    // migration may have replaced one of PostgreSQL's own functions that the read uses. Before any
    // script ran, money-guard itself failed (a broken install, say): not a ToolError, so the server
    // answers INTERNAL_ERROR without detail and logs the type and code locations, the worker's error
    // as the cause (SPEC.md §2.1).
    const stopped = (why: string, cause?: Error): Error => {
      if (running < 0) {
        const err = new Error('the lint database could not start', { cause });
        err.name = 'DatabaseStartError';
        return err;
      }
      const script = scriptAt(running);
      const culprit = reading ? "the statement that breaks the read (one that replaces PostgreSQL's own functions, say)" : 'the statement that stops the database';
      const fix = wayPast(script, options.single, {
        setup: `Take ${culprit} out of the setup file.`,
        folder: `Leave the file out with files, or lint it on its own to find ${culprit}.`,
        single: `Lint parts of the file on their own to find ${culprit}.`,
      });
      const what = reading ? 'the catalog could not be read after this file, the last one' : 'the database stopped while running this file';
      return new ToolError(failedCode(script), `${script.name}: ${what} (${clip(why, 200)}).`, fix);
    };
    // After a statement PGlite cannot carry out (COPY ... PROGRAM), the database answers wrongly or not at all.
    const stuck = (step: number, what: string): ToolError => {
      const script = scriptAt(step);
      const fix = wayPast(script, options.single, { setup: 'Take that statement out of the setup file.', folder: 'Leave the file out with files.', single: 'Lint a copy without that statement.' });
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
          finish({ error: new ToolError(failedCode(script), `${script.name}: the lint database grew by more than ${formatMib(memoryLimit)} of memory ${reading ? 'while reading the catalog after this file, the last one' : 'while running this file'}.`, tooBig(script, options.single)) });
        },
        () => {
          measuring = false; // the thread has just ended: its own exit says why
        },
      );
    }, MEMORY_CHECK_MS);

    const overall = setTimeout(() => {
      const script = running >= 0 ? scriptAt(running) : undefined;
      const doing = script === undefined ? 'starting the database' : reading ? 'reading the catalog, after every file had run' : `running ${script.name}`;
      const slow =
        script === undefined
          ? ''
          : `${wayPast(script, options.single, { setup: 'Take slow data loading out of the setup file.', folder: 'Leave slow data-loading files out with files.', single: 'If the file loads data, lint a schema-only copy (pg_dump --schema-only).' })} `;
      finish({ error: new ToolError('TIMEOUT', `The lint ran out of time (${options.timeoutMs / 1000} s) while ${doing}.`, `${slow}A larger timeout_seconds (at most 300) helps only with a client that waits longer than 60 seconds for an answer.`) });
    }, Math.max(0, options.timeoutMs - (Date.now() - calledAt)));
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
          // The columns this file created or changed. One it dropped keeps its entry, which nothing
          // reads: its table oid and column number are never given to another column.
          for (const [col, ty] of m.rows) {
            const prev = since.get(col);
            if (prev === undefined || prev.ty !== ty) since.set(col, { ty, since: index });
          }
          break;
        }
        case 'reading':
          reading = true;
          break;
        case 'failed':
          finish({ error: failure(scriptAt(m.step), m.error, { available, preset: options.preset, filesGiven: options.filesGiven ?? false, single: options.single ?? false }) });
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
