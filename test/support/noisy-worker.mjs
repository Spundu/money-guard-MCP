// A stand-in for src/lint/worker.js that writes to stdout and stderr every way a thread can, then
// answers like a database with no tables. test/database.test.ts proves none of it reaches the
// server's own stdout (the protocol channel) or stderr.
import process from 'node:process';
import { parentPort } from 'node:worker_threads';

console.log('LEAK: console.log from the worker');
console.error('LEAK: console.error from the worker');
process.stdout.write('LEAK: process.stdout.write from the worker\n');
process.stderr.write('LEAK: process.stderr.write from the worker\n');
parentPort?.postMessage({ type: 'ready', version: 'PostgreSQL 0 (fake) on nowhere', available: [] });
parentPort?.postMessage({ type: 'done', detail: [] });
