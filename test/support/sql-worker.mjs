// A database thread for SQL the tests run themselves (test/support/sql.ts). It speaks the messages of
// src/lint/worker.js, so it runs through runScripts, one database thread at a time: it executes every
// script but the last, and answers with the rows of the last one.
import { PGlite } from '@electric-sql/pglite';
import { parentPort, workerData } from 'node:worker_threads';

const post = (message) => parentPort?.postMessage(message);
const { scripts } = workerData;
const db = await PGlite.create();
post({ type: 'ready', version: 'PostgreSQL (tests) on nowhere', available: [], reserved: [] });
for (const [step, script] of scripts.entries()) {
  post({ type: 'running', step });
  try {
    if (step < scripts.length - 1) await db.exec(script.text);
    else post({ type: 'done', detail: (await db.query(script.text)).rows });
  } catch (err) {
    post({ type: 'failed', step, error: { message: String(err?.message ?? err), code: err?.code, position: err?.position } });
    break;
  }
}
