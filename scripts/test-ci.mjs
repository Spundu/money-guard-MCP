// CI's test step: `npm test`, run once more only when Node.js 24's V8 abort ended it (SPEC.md §1 fact 7).
// That abort can still end a test run on a busy machine (review round 17), though one database thread at a
// time makes it rare; any other failure fails the step at once. The second run's output is what counts.
import { spawn } from 'node:child_process';
import process from 'node:process';

const V8_ABORT = 'Check failed: jit_page_->allocations_.erase(addr) == 1';

/** Runs npm test with its output shown as it comes (review round 18: a CI time limit left no log), and
 *  looks for the abort in all of it, each chunk joined to the end of the one before. */
function run() {
  return new Promise((resolve) => {
    const child = spawn('npm', ['test'], { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let aborted = false;
    const keep = (out) => {
      let end = '';
      return (chunk) => {
        out.write(chunk);
        const text = end + chunk.toString('utf8');
        aborted ||= text.includes(V8_ABORT);
        end = text.slice(-V8_ABORT.length);
      };
    };
    child.stdout.on('data', keep(process.stdout));
    child.stderr.on('data', keep(process.stderr));
    child.on('error', (err) => {
      console.error(`test-ci: npm test did not start: ${err.message}`);
      resolve({ code: 1, aborted: false });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, aborted }));
  });
}

const first = await run();
if (first.code === 0) process.exit(0);
if (!first.aborted) process.exit(first.code);
console.error(`\ntest-ci: the run ended with Node.js ${process.version}'s V8 abort (${V8_ABORT}); running the tests once more.\n`);
process.exit((await run()).code);
