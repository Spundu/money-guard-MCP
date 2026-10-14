// Vitest global setup: build dist/ once, before any test file runs. The stdio and README tests start the
// built server, so they must run what ships, built from the current source; one build also avoids two
// test files writing dist/ at the same time.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

export default function build(): void {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: path.resolve(import.meta.dirname, '..', '..'), stdio: 'pipe' });
}
