// Loaded with --import by test/stdio.test.ts. Once the file MONEY_GUARD_TEST_THROW names exists (the
// server is serving by then), it throws an error that no handler catches and rejects a promise that no
// one handles. The server must log their types, never their messages, and keep serving.
import { existsSync } from 'node:fs';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

const signal = process.env.MONEY_GUARD_TEST_THROW;
const wait = setInterval(() => {
  if (signal === undefined || !existsSync(signal)) return;
  clearInterval(wait);
  setTimeout(() => {
    throw new TypeError('secret detail of an error no one caught');
  }, 0);
  setTimeout(() => {
    void Promise.reject(new RangeError('secret detail of a rejection no one handled'));
  }, 50);
}, 20);
wait.unref();
