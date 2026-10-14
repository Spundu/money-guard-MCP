// SQL the tests run themselves (fix_sql on real rows), in a database thread of its own that goes
// through runScripts. Never start PGlite on a test's own thread beside lints: on Node.js 24, a database
// that starts while another is torn down can make V8 abort the whole process (nodejs/node#66366), and
// runScripts starts one database thread at a time.
import { runScripts } from '../../src/lint/database.js';

const SQL_WORKER = new URL('./sql-worker.mjs', import.meta.url);

/**
 * Runs `statements` in order in a fresh database and returns the rows of `query`. A statement that
 * fails rejects with a ToolError naming it ("statement 2") and quoting PostgreSQL's message.
 */
export async function sql(statements: readonly string[], query = 'select 1 as ok'): Promise<Array<Record<string, unknown>>> {
  const scripts = [...statements, query].map((text, i) => ({ name: `statement ${i + 1}`, text, phase: 'migration' as const }));
  const { detail } = await runScripts(scripts, { timeoutMs: 60_000, preset: false, worker: SQL_WORKER });
  return detail as unknown as Array<Record<string, unknown>>;
}
