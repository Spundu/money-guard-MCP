// @ts-check
// money_lint_schema's database, in its own thread (SPEC.md §3.4). It runs SQL scripts in a fresh
// in-memory PGlite (PostgreSQL 18 in WebAssembly) and reports what the catalog says after each one. It
// decides nothing: the main thread owns the time limits, the judging and the error messages, and
// terminates this thread when time runs out or the call is cancelled. The database lives only in memory
// and sees only a virtual filesystem, so a migration cannot reach the computer's files or programs.
//
// Plain JavaScript (checked by tsc through JSDoc) so the same file runs under the tests and from dist/.

import { parentPort, workerData } from 'node:worker_threads';
import { PGlite } from '@electric-sql/pglite';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { auto_explain } from '@electric-sql/pglite/contrib/auto_explain';
import { bloom } from '@electric-sql/pglite/contrib/bloom';
import { btree_gin } from '@electric-sql/pglite/contrib/btree_gin';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { cube } from '@electric-sql/pglite/contrib/cube';
import { dict_int } from '@electric-sql/pglite/contrib/dict_int';
import { dict_xsyn } from '@electric-sql/pglite/contrib/dict_xsyn';
import { earthdistance } from '@electric-sql/pglite/contrib/earthdistance';
import { file_fdw } from '@electric-sql/pglite/contrib/file_fdw';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { intarray } from '@electric-sql/pglite/contrib/intarray';
import { isn } from '@electric-sql/pglite/contrib/isn';
import { lo } from '@electric-sql/pglite/contrib/lo';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { moddatetime } from '@electric-sql/pglite/contrib/moddatetime';
import { pageinspect } from '@electric-sql/pglite/contrib/pageinspect';
import { pg_buffercache } from '@electric-sql/pglite/contrib/pg_buffercache';
import { pg_freespacemap } from '@electric-sql/pglite/contrib/pg_freespacemap';
import { pg_stat_statements } from '@electric-sql/pglite/contrib/pg_stat_statements';
import { pg_surgery } from '@electric-sql/pglite/contrib/pg_surgery';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_visibility } from '@electric-sql/pglite/contrib/pg_visibility';
import { pg_walinspect } from '@electric-sql/pglite/contrib/pg_walinspect';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { seg } from '@electric-sql/pglite/contrib/seg';
import { tablefunc } from '@electric-sql/pglite/contrib/tablefunc';
import { tcn } from '@electric-sql/pglite/contrib/tcn';
import { tsm_system_rows } from '@electric-sql/pglite/contrib/tsm_system_rows';
import { tsm_system_time } from '@electric-sql/pglite/contrib/tsm_system_time';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { vector } from '@electric-sql/pglite-pgvector';

/**
 * @typedef {{ name: string, text: string }} Script
 * @typedef {{ scripts: Script[], markSql: string, snapshotSql: string, detailSql: string }} Job
 * @typedef {{ message: string, name?: string, code?: string, position?: string, detail?: string, hint?: string, where?: string }} DbError
 */

const extensions = {
  amcheck, auto_explain, bloom, btree_gin, btree_gist, citext, cube, dict_int, dict_xsyn, earthdistance,
  file_fdw, fuzzystrmatch, hstore, intarray, isn, lo, ltree, moddatetime, pageinspect, pg_buffercache,
  pg_freespacemap, pg_stat_statements, pg_surgery, pg_trgm, pg_visibility, pg_walinspect, pgcrypto, seg,
  tablefunc, tcn, tsm_system_rows, tsm_system_time, unaccent, uuid_ossp, vector,
};

/** The failure for a file that ends inside a transaction it opened; src/lint/advice.ts matches this text for its hint. */
const OPEN_TRANSACTION = 'the file ends inside a transaction it opened (BEGIN with no COMMIT or ROLLBACK)';

/** @param {unknown} message */
function send(message) {
  parentPort?.postMessage(message);
}

/**
 * The fields of a PostgreSQL error worth reporting, as plain data (it crosses a thread).
 * @param {unknown} err
 * @returns {DbError}
 */
function dbError(err) {
  /** @type {Record<string, unknown>} */
  const e = err !== null && typeof err === 'object' ? /** @type {Record<string, unknown>} */ (err) : {};
  /** @type {DbError} */
  const out = { message: typeof e.message === 'string' ? e.message : String(err) };
  for (const key of /** @type {const} */ (['name', 'code', 'position', 'detail', 'hint', 'where'])) {
    if (typeof e[key] === 'string') out[key] = /** @type {string} */ (e[key]);
  }
  return out;
}

async function main() {
  const job = /** @type {Job} */ (workerData);
  // Each file runs as one transaction, which locks every table, sequence and index it creates: a one-file
  // schema dump of a few thousand tables needs more locks than PostgreSQL's default 64 per transaction.
  const db = await PGlite.create({ extensions, postgresqlconf: 'max_locks_per_transaction = 4096' });
  const version = /** @type {{ v: string }} */ ((await db.query('SELECT pg_catalog.version() AS v')).rows[0]).v;
  const available = (await db.query('SELECT name FROM pg_catalog.pg_available_extensions ORDER BY name')).rows.map(
    (r) => /** @type {{ name: string }} */ (r).name,
  );
  // The keywords a name must be quoted for, read now, before any script could redefine anything: the
  // main thread quotes the names in fix_sql itself.
  const reserved = (await db.query("SELECT word FROM pg_catalog.pg_get_keywords() WHERE catcode <> 'U'")).rows.map(
    (r) => /** @type {{ word: string }} */ (r).word,
  );
  send({ type: 'ready', version, available, reserved });

  for (const [step, script] of job.scripts.entries()) {
    send({ type: 'running', step });
    const mark = /** @type {{ mark: string }} */ ((await db.query(job.markSql)).rows[0]).mark;
    try {
      await db.exec(script.text);
    } catch (err) {
      send({ type: 'failed', step, error: dbError(err) });
      return;
    }
    send({ type: 'executed', step });
    // A statement PGlite cannot carry out (COPY ... PROGRAM) can leave the session answering nonsense
    // or nothing at all; the main thread times this check out.
    const sane = await db.query('SELECT 1 AS ok').catch(() => null);
    if (/** @type {{ ok?: unknown } | undefined} */ (sane?.rows?.[0])?.ok !== 1) {
      send({ type: 'unusable', step });
      return;
    }
    // A file that ends inside a transaction it opened (BEGIN with no COMMIT) would make the next files
    // run inside it, and the check after them could not tell what they changed. A savepoint can only
    // be set inside a transaction.
    const open = await db.query('SAVEPOINT money_guard_open').then(
      async () => (await db.query('RELEASE SAVEPOINT money_guard_open'), true),
      () => false,
    );
    if (open) {
      send({ type: 'failed', step, error: { message: OPEN_TRANSACTION } });
      return;
    }
    const rows = (await db.query(job.snapshotSql, [mark])).rows.map((r) => {
      const row = /** @type {{ col: unknown, ty: unknown }} */ (r);
      return [row.col, row.ty];
    });
    // A migration can replace the functions these are built with and make them huge, which the main thread
    // would keep to the end of the lint, past this thread's limits (review round 18): checked here.
    if (!rows.every(([col, ty]) => typeof col === 'string' && /^\d{1,10}:\d{1,5}$/.test(col) && typeof ty === 'string' && /^(?:float|\d{1,10})$/.test(ty))) {
      send({ type: 'unusable', step });
      return;
    }
    send({ type: 'snapshot', step, rows });
  }
  // Said first, so a time limit or a failure while the catalog is read says so, rather than seeming to
  // happen while the last file ran.
  send({ type: 'reading' });
  const detail = bounded((await db.query(job.detailSql)).rows);
  send({ type: 'done', detail });
  await db.close();
}

/**
 * The catalog rows with their expression texts bounded here, where a migration cannot change the code
 * (review round 17: it can replace pg_catalog.length, and an inheritance chain multiplied distinct
 * defaults to 194 million characters). A text over 2,000 characters, past the 50th of a column, or past
 * 1,000,000 characters in all is left out, and one stand-in takes the place of all a column lost, which
 * the main thread reads as possibly holding an amount: for defaults a text over 2,000 characters, for
 * CHECKs and index texts null. A value that is not text is passed on, for the main thread to refuse.
 * @param {unknown[]} rows
 */
function bounded(rows) {
  let left = 1_000_000;
  /** @param {unknown} texts @param {string | null} stand */
  const bound = (texts, stand) => {
    if (!Array.isArray(texts)) return texts;
    /** @type {unknown[]} */
    const out = [];
    let lost = false;
    for (const t of texts) {
      if (typeof t === 'string' && (t.length > 2000 || t.length > left || out.length >= 50)) {
        lost = true;
        continue;
      }
      if (typeof t === 'string') left -= t.length;
      out.push(t);
    }
    if (lost) out.push(stand);
    return out;
  };
  // Names and the column key are short in a database whose functions are PostgreSQL's own (a name is at most
  // 63 bytes); one that is not sends a row the main thread refuses as a value of the wrong kind, not the text.
  // A type's text is cut instead, as a result shows it cut (review round 18: a replaced textcat or format_type
  // made them huge, past this thread's limits once the main thread held them).
  const EXPRESSIONS = ['defaults', 'checks', 'index_exprs'];
  const TYPES = ['declared', 'domain_name'];
  const sane = (/** @type {Record<string, unknown>} */ row) =>
    typeof row.col === 'string' && /^\d{1,10}:\d{1,5}$/.test(row.col) && Object.entries(row).every(([k, v]) => EXPRESSIONS.includes(k) || TYPES.includes(k) || typeof v !== 'string' || v.length <= 512);
  if (!rows.every((r) => sane(/** @type {Record<string, unknown>} */ (r)))) return [null];
  /** @param {unknown} v */
  const short = (v) => (typeof v === 'string' && v.length > 512 ? v.slice(0, 512) : v);
  return rows.map((r) => {
    const row = /** @type {Record<string, unknown>} */ (r);
    return { ...row, declared: short(row.declared), domain_name: short(row.domain_name), defaults: bound(row.defaults, 'x'.repeat(2001)), checks: bound(row.checks, null), index_exprs: bound(row.index_exprs, null) };
  });
}

main().catch((err) => send({ type: 'crashed', error: dbError(err) }));
