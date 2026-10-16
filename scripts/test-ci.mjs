// CI's test step: `npm test`, run once more only when Node.js 24's V8 abort ended it (SPEC.md §1 fact 7).
// That abort can still end a test run on a busy machine (review round 17), though one database thread at a
// time makes it rare; any other failure fails the step at once. The second run's output is what counts.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const V8_ABORT = 'Check failed: jit_page_->allocations_.erase(addr) == 1';

function run() {
  const result = spawnSync('npm', ['test'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return { code: result.status ?? 1, aborted: `${result.stdout}${result.stderr}`.includes(V8_ABORT) };
}

const first = run();
if (first.code === 0) process.exit(0);
if (!first.aborted) process.exit(first.code);
console.error(`\ntest-ci: the run ended with Node.js ${process.version}'s V8 abort (${V8_ABORT}); running the tests once more.\n`);
process.exit(run().code);
