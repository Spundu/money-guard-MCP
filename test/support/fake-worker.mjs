// A stand-in for src/lint/worker.js, for test/database.test.ts. MONEY_GUARD_TEST_WORKER picks how it
// misbehaves:
//   "silent":   it says the first script ran, then never answers again (a database that hangs);
//   "unusable": it says the first script ran, then that the database no longer answers correctly (as
//               after COPY ... PROGRAM);
//   "endless":  it never answers at all, and writes a heartbeat to the file MONEY_GUARD_TEST_HEARTBEAT
//               names every 20 ms, so a test can see whether the thread is still alive.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval } from 'node:timers';
import { parentPort } from 'node:worker_threads';

const mode = process.env.MONEY_GUARD_TEST_WORKER;
if (mode === 'endless') {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let beat = 0; ; beat += 1) {
    writeFileSync(process.env.MONEY_GUARD_TEST_HEARTBEAT ?? 'heartbeat', String(beat));
    Atomics.wait(pause, 0, 0, 20);
  }
}
parentPort?.postMessage({ type: 'ready', version: 'PostgreSQL 0 (fake) on nowhere', available: [] });
parentPort?.postMessage({ type: 'running', step: 0 });
parentPort?.postMessage({ type: 'executed', step: 0 });
if (mode === 'unusable') parentPort?.postMessage({ type: 'unusable', step: 0 });
else setInterval(() => {}, 1000); // silent: stay alive, and say nothing
