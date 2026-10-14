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
 * @typedef {{ scripts: Script[], snapshotSql: string, detailSql: string }} Job
 * @typedef {{ message: string, code?: string, position?: string, detail?: string, hint?: string, where?: string }} DbError
 */

const extensions = {
  amcheck, auto_explain, bloom, btree_gin, btree_gist, citext, cube, dict_int, dict_xsyn, earthdistance,
  file_fdw, fuzzystrmatch, hstore, intarray, isn, lo, ltree, moddatetime, pageinspect, pg_buffercache,
  pg_freespacemap, pg_stat_statements, pg_surgery, pg_trgm, pg_visibility, pg_walinspect, pgcrypto, seg,
  tablefunc, tcn, tsm_system_rows, tsm_system_time, unaccent, uuid_ossp, vector,
};

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
  for (const key of /** @type {const} */ (['code', 'position', 'detail', 'hint', 'where'])) {
    if (typeof e[key] === 'string') out[key] = /** @type {string} */ (e[key]);
  }
  return out;
}

async function main() {
  const job = /** @type {Job} */ (workerData);
  const db = await PGlite.create({ extensions });
  const version = /** @type {{ v: string }} */ ((await db.query('SELECT pg_catalog.version() AS v')).rows[0]).v;
  const available = (await db.query('SELECT name FROM pg_catalog.pg_available_extensions ORDER BY name')).rows.map(
    (r) => /** @type {{ name: string }} */ (r).name,
  );
  send({ type: 'ready', version, available });

  for (const [step, script] of job.scripts.entries()) {
    send({ type: 'running', step });
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
    const rows = (await db.query(job.snapshotSql)).rows.map((r) => {
      const row = /** @type {{ col: string, ty: string }} */ (r);
      return [row.col, row.ty];
    });
    send({ type: 'snapshot', step, rows });
  }
  const detail = (await db.query(job.detailSql)).rows;
  send({ type: 'done', detail });
  await db.close();
}

main().catch((err) => send({ type: 'crashed', error: dbError(err) }));
