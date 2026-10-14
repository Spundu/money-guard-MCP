// A stand-in for src/lint/worker.js, for test/database.test.ts. MONEY_GUARD_TEST_WORKER picks how it
// misbehaves:
//   "silent":   it says the first script ran, then never answers again (a database that hangs);
//   "unusable": it says the first script ran, then that the database no longer answers correctly (as
//               after COPY ... PROGRAM);
//   "endless":  it never answers at all, and writes a heartbeat to the file MONEY_GUARD_TEST_HEARTBEAT
//               names every 20 ms, so a test can see whether the thread is still alive;
//   "broken":   it fails before the database starts, as a broken install would (a module not found),
//               with a message that holds an absolute path;
//   "late":     it says the first script ran, answers the check after it only 500 ms later, and ends
//               1 second after that;
//   "slow":     it starts, writes the file MONEY_GUARD_TEST_HEARTBEAT names, and runs the first script
//               only once that name with ".go" added exists;
//   "crash":    it says the first script is running, then dies (an uncaught error) while it runs;
//   "hang":     it says the first script is running, then never answers again (a script that runs on);
//   "reading":  it runs the first script, says it is reading the catalog, then never answers again;
//   "reading-crash": it runs the first script, says it is reading the catalog, then dies;
//   "reading-grows": it runs the first script, says it is reading the catalog, then takes 256 MiB.
import { Buffer } from 'node:buffer';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';
import { parentPort } from 'node:worker_threads';

const mode = process.env.MONEY_GUARD_TEST_WORKER;
const heartbeat = process.env.MONEY_GUARD_TEST_HEARTBEAT ?? 'heartbeat';
const pause = new Int32Array(new SharedArrayBuffer(4));
if (mode === 'broken') {
  throw Object.assign(new Error("Cannot find module '/home/jo/Private Clients/money-guard/dist/lint/missing.js'"), { code: 'ERR_MODULE_NOT_FOUND' });
}
if (mode === 'endless') {
  for (let beat = 0; ; beat += 1) {
    writeFileSync(heartbeat, String(beat));
    Atomics.wait(pause, 0, 0, 20);
  }
}
const post = (message) => parentPort?.postMessage(message);
post({ type: 'ready', version: 'PostgreSQL 0 (fake) on nowhere', available: [] });
if (mode === 'slow') {
  writeFileSync(heartbeat, 'started');
  while (!existsSync(`${heartbeat}.go`)) Atomics.wait(pause, 0, 0, 20);
}
post({ type: 'running', step: 0 });
if (mode === 'crash') {
  setTimeout(() => {
    throw new Error('the database thread died');
  }, 50);
} else if (mode !== 'hang') {
  post({ type: 'executed', step: 0 });
}
const answer = () => {
  post({ type: 'snapshot', step: 0, rows: [] });
  post({ type: 'done', detail: [] });
};
if (mode === 'unusable') post({ type: 'unusable', step: 0 });
else if (mode === 'slow') answer();
else if (mode === 'late') {
  setTimeout(() => post({ type: 'snapshot', step: 0, rows: [] }), 500);
  setTimeout(() => post({ type: 'done', detail: [] }), 1500);
} else if (mode === 'reading' || mode === 'reading-crash' || mode === 'reading-grows') {
  post({ type: 'snapshot', step: 0, rows: [] });
  post({ type: 'reading' });
  if (mode === 'reading-crash') {
    setTimeout(() => {
      throw new Error('the database thread died');
    }, 50);
  }
  // Later than the memory baseline, which the server takes once the database has started.
  if (mode === 'reading-grows') setTimeout(() => globalThis.held = Buffer.alloc(256 * 1024 * 1024, 1), 300);
}
setInterval(() => {}, 1000); // stay alive until the server ends the thread (silent: and say nothing)
