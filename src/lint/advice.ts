// The advice in money_lint_schema's errors (SPEC.md §3.8): the code a script fails with, and the hint
// that fits the script (the setup file, a migration in a folder, or the one file migrations names)
// and what PostgreSQL said.

import { quoted } from '../echo.js';
import { ToolError } from '../errors.js';
import type { DbError, Script } from './database.js';

/** What the database thread (worker.js) says of a file that ends inside a transaction it opened: the same text there. */
const OPEN_TRANSACTION = 'the file ends inside a transaction it opened (BEGIN with no COMMIT or ROLLBACK)';

/** A setup script (the preset or the setup file) fails as SETUP_FAILED, a migration as MIGRATION_FAILED. */
export function failedCode(script: Script): 'SETUP_FAILED' | 'MIGRATION_FAILED' {
  return script.phase === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED';
}

/**
 * The fix's way past a script that went wrong. The setup file is not one of the migrations, and files
 * needs a folder: when migrations is one file, only a copy of it can leave a part out.
 */
export function wayPast(script: Script, single: boolean | undefined, ways: { setup: string; folder: string; single: string }): string {
  return script.phase === 'setup' ? ways.setup : single === true ? ways.single : ways.folder;
}

/** The fix for a file that needs more than the database can give. */
export function tooBig(script: Script, single: boolean | undefined): string {
  const way = wayPast(script, single, {
    setup: 'Take that part out of the setup file.',
    folder: 'Leave the file out with files, or lint one schema-only dump of the database the migrations build (pg_dump --schema-only).',
    single: 'Lint a copy without the part that needs it (a large data load, say).',
  });
  return `The file needs more than the lint database can give it (memory or a size limit). ${way}`;
}

/** 1-based line and column of the character at 1-based position `position`, counted in code points as PostgreSQL counts. */
export function locate(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  let i = 0;
  for (const ch of text) {
    i += 1;
    if (i >= position) break;
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const MISSING_OBJECT = new Set(['42704', '3F000', '42883', '42P01']);

/** Duplicate table, object (a role, an extension), schema and function. */
const ALREADY_EXISTS = new Set(['42P07', '42710', '42P06', '42723']);

/** The ToolError for a script that PostgreSQL refused, with a hint fitted to the error. `single`: migrations is this one file. */
export function failure(script: Script, err: DbError, context: { available: readonly string[]; preset: boolean; filesGiven?: boolean; single?: boolean; setupGiven?: boolean }): ToolError {
  const code = failedCode(script);
  // The setup file runs before the migrations and is not one of them: its advice is to change it.
  const setup = script.phase === 'setup';
  const past = (ways: { setup: string; folder: string; single: string }) => wayPast(script, context.single, ways);
  const position = err.position === undefined ? Number.NaN : Number(err.position);
  const at = Number.isInteger(position) && position > 0 ? locate(script.text, position) : null;
  const where = at === null ? script.name : `${script.name} line ${at.line}, column ${at.column}`;
  // A migration writes these (RAISE EXCEPTION takes any text): in quotes, so they cannot close them
  // and add a "Fix:" of their own (review round 10).
  const detail = err.detail ? ` (${quoted(err.detail, 120)})` : '';
  const state = err.code ? ` (SQLSTATE ${err.code})` : '';
  // money-guard's own text (an open transaction) is shown as it is: it is a fixed sentence.
  const said = err.message === OPEN_TRANSACTION ? OPEN_TRANSACTION : quoted(err.message, 300);
  const message = `${where}: ${said}${detail}${state}.`;

  const lines = script.text.split('\n');
  let fix: string;
  if (err.message === OPEN_TRANSACTION) {
    fix = `money-guard runs each file as one script, and a file must not leave a transaction open: add the COMMIT it lacks, or take out its BEGIN. ${past({ setup: 'Fix the setup file.', folder: 'Then lint again.', single: 'Then lint again.' })}`;
  } else if (/^extension ".*" is not available$/.test(err.message)) {
    fix =
      `PGlite does not have that extension. It has: ${context.available.join(', ')}. If the file uses it for something unrelated to money, ${past({ setup: 'take that part out of the setup file', folder: 'leave the file out with files', single: 'lint a copy of the file without that part' })}. ` +
      'A whole-database dump (pg_dump, supabase db dump) also creates the extensions a platform provides: lint the migrations folder instead (supabase/migrations for Supabase).';
  } else if (err.code === '42883' && err.message.startsWith('operator does not exist')) {
    fix = 'The two sides of an operator have types that do not go together (uuid and text, say): cast one side, or fix the column type.';
  } else if (err.code !== undefined && ALREADY_EXISTS.has(err.code) && /"(?:public|plpgsql)"/.test(err.message)) {
    fix = 'Every PostgreSQL database already has the public schema and the plpgsql language: leave them out, or create them with IF NOT EXISTS.';
  } else if (err.code !== undefined && ALREADY_EXISTS.has(err.code)) {
    // setup or a preset cannot help here: they may be what made it first.
    fix = `${context.preset ? 'The Supabase preset already creates some objects (roles such as anon, the auth and extensions schemas): leave those out here, or create them with IF NOT EXISTS. ' : ''}Something creates this object twice: ${past({ setup: 'the setup file itself', folder: context.setupGiven === true ? 'the file itself, the setup file and a migration, two migrations, or files run out of order' : 'the file itself, two migrations, or files run out of order', single: context.setupGiven === true ? 'the file itself, or the setup file and the file' : 'the file itself' })}. Create it once, or with IF NOT EXISTS.`;
  } else if (setup && err.code !== undefined && MISSING_OBJECT.has(err.code)) {
    fix = context.preset
      ? 'The Supabase preset does not create this: create it earlier in the setup file.'
      : 'The setup file runs before the migrations: create what it needs earlier in the same file, or, for a Supabase project, call again with preset "supabase".';
  } else if (err.code !== undefined && MISSING_OBJECT.has(err.code)) {
    // A missing table or function is often one of the project's own, created by a file that sorts later
    // (Flyway's R__ files sort before V1__): say that first.
    const ran = context.filesGiven
      ? 'the files ran in the order files gives; put the file that creates it first. '
      : 'money-guard runs them in natural order of their paths; pass files to give the order your tool uses. ';
    // A missing type is often a typo (intt) or an enum a later file creates (review round 10): those
    // first, the platform after. One migrations file has no order to get wrong.
    const type = err.code === '42704' && /^type "/.test(err.message);
    const order = !context.single && (err.code === '42P01' || err.code === '42883' || type) ? `If one of your migrations creates it, the files ran out of order: ${ran}` : '';
    fix =
      (type ? 'Check the spelling of the type. ' : '') +
      order +
      (context.preset
        ? 'The Supabase preset does not create this. Pass setup: a .sql file that creates it (it runs after the preset).'
        : 'This file needs objects your platform creates. For a Supabase project call again with preset "supabase"; otherwise pass setup: a .sql file that creates them (CREATE ROLE ..., CREATE SCHEMA ...).');
  } else if (err.code === '42601' && at !== null && (lines[at.line - 1] ?? '').startsWith('\\')) {
    fix = `That line is a psql meta-command, which only psql understands. ${past({ setup: 'Take it out of the setup file.', folder: 'Leave the file out with files, or lint a copy without that line.', single: 'Lint a copy without that line.' })}`;
  } else if (err.code === '42601' && at !== null && lines.slice(0, at.line - 1).some((line) => /^COPY\s.+\sFROM\s+stdin;/i.test(line))) {
    // pg_dump writes table rows after "COPY ... FROM stdin;" lines; only psql can feed them in.
    fix = `The file holds table data after COPY ... FROM stdin (a pg_dump with data), which only psql can load. ${setup ? 'Take the data out of the setup file.' : 'Lint a schema-only dump (pg_dump --schema-only) or the migrations folder instead.'}`;
  } else if (err.code === '25001') {
    // Alone in its file such a statement runs (review round 11): it fails beside others in one script.
    fix = `money-guard runs each file as one script, and this statement cannot run beside other statements in one (psql, which commits statement by statement, can). ${past({ setup: 'Take it out of the setup file.', folder: 'Move it to a file of its own, or leave the file out with files.', single: 'Lint a copy without it.' })}`;
  } else if (err.code === '0A000' && /^cannot alter type of a column used (?:by|in) /.test(err.message)) {
    fix = 'Something else uses this column (a view, a rule, a policy, a trigger, a generated column or a function with a BEGIN ATOMIC body): in the same migration, drop it before the ALTER and create it again after.';
  } else if (err.code === '55P04') {
    fix = `money-guard runs each file as one transaction, and a new enum value cannot be used in the transaction that adds it (psql, which commits statement by statement, can). ${past({ setup: 'Take that part out of the setup file.', folder: 'Split the file in two, or leave it out with files.', single: 'Split the file in two, put both in a folder, and lint the folder.' })}`;
  } else if (err.code === '53200' && /max_locks_per_transaction/.test(err.hint ?? '')) {
    // Out of lock slots, not of memory: one file creates more objects than one transaction may lock.
    fix = `The file creates more objects than one transaction can hold locks for (a schema dump of many thousands of tables, say). ${past({ setup: 'Make the setup file smaller.', folder: 'Split it into several files.', single: 'Split it into a folder of smaller files, and lint the folder.' })}`;
  } else if (err.code !== undefined && /^5[34]/.test(err.code)) {
    fix = tooBig(script, context.single);
  } else if (setup) {
    fix = 'Fix the setup file at that place.';
  } else if (err.code === '42601') {
    fix = 'Fix the SQL at that place: PostgreSQL could not read it as written.'; // setup or preset cannot help a typo
  } else {
    fix = 'If this file runs on your real database, it probably needs objects your platform creates: pass setup or preset. Otherwise fix the SQL at that place.';
  }
  return new ToolError(code, message, fix);
}
