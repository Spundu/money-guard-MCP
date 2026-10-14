// Which migration files run, in which order, and as what text (SPEC.md §3.3). Only file-format markers
// are recognised, line by line: the up and down markers of tools that keep both directions in one file,
// and pg_dump's \restrict lines. The SQL itself is never parsed; Postgres runs it.

import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { clip, clipPath } from '../echo.js';
import { ToolError } from '../errors.js';
import { deniedOrLocked, formatMib, formatSize, isInside, isSensitive, readChecked, resolveInRoot, toPosix, unreadable, type Root } from '../paths.js';

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface SqlScript {
  /** Relative to the project root, "/" separators: what results show. */
  rel: string;
  /** The SQL as it runs: dbmate's down part cut, pg_dump's \restrict lines blanked. */
  text: string;
}

export interface Sources {
  /** The `migrations` argument, normalised. */
  migrations: string;
  setup: SqlScript | null;
  files: SqlScript[];
  /** SHA-256 over every applied file (path, NUL, bytes), setup first, then the migrations in order. */
  sha256: string;
}

/** Compare one path segment: runs of digits by numeric value, everything else by character code. */
function compareSegment(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i += 1) {
    const x = ta[i] ?? '';
    const y = tb[i] ?? '';
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const nx = x.replace(/^0+/, '');
      const ny = y.replace(/^0+/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length; // "1" before "01": a total order
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

/** Natural order of "/"-separated relative paths, folder by folder: V2 before V10, 0001 before 0002. */
export function naturalCompare(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const c = compareSegment(sa[i] ?? '', sb[i] ?? '');
    if (c !== 0) return c;
  }
  return sa.length - sb.length;
}

/**
 * Files that only undo migrations, which would drop the schema if they ran: golang-migrate and Diesel
 * (down.sql, *.down.sql), Postgrator (*.undo.sql) and yoyo (*.rollback.sql).
 */
function isDownFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'down.sql' || ['.down.sql', '.undo.sql', '.rollback.sql'].some((suffix) => lower.endsWith(suffix));
}

/**
 * The markers of tools that keep both directions in one file, matched by line, not SQL: dbmate
 * ("-- migrate:up", "-- migrate:down", maybe followed by options), goose ("-- +goose Up"), sql-migrate
 * ("-- +migrate Up"), node-pg-migrate ("-- Up Migration", as its own parser reads it: indented, or
 * with more dashes) and tern ("---- create above / drop below ----", which has no up marker). A down
 * marker counts only in a file that holds its tool's up marker, so a comment such as "-- Down migration
 * (manual)" in an ordinary file cuts nothing.
 */
const TOOLS: ReadonlyArray<{ up: RegExp | null; down: RegExp }> = [
  { up: /^--\s*migrate:up(?:\s|$)/, down: /^--\s*migrate:down(?:\s|$)/ },
  { up: /^--\s*\+goose\s+up(?:\s|$)/i, down: /^--\s*\+goose\s+down(?:\s|$)/i },
  { up: /^--\s*\+migrate\s+up(?:\s|$)/i, down: /^--\s*\+migrate\s+down(?:\s|$)/i },
  { up: /^\s*--[\s-]*up\s+migration/i, down: /^\s*--[\s-]*down\s+migration/i },
  { up: null, down: /^-{4}\s*create above\s*\/\s*drop below\s*-{4}/i },
];

/**
 * The SQL as it runs: the down part of a file that holds both directions, from a down marker to the
 * next up marker (or the end), becomes spaces, and so do lines starting \restrict or \unrestrict (psql
 * directives written by pg_dump 17.6 and later). Every line keeps its length, so the positions
 * Postgres reports still point at the right line and column.
 */
export function prepareSql(text: string): string {
  const lines = text.split('\n');
  const tool = TOOLS.find((t) => lines.some((line) => (t.up ?? t.down).test(line)));
  let down = false;
  return lines
    .map((line) => {
      if (tool?.up?.test(line)) down = false;
      else if (tool?.down.test(line)) down = true;
      return down || /^\\(?:restrict|unrestrict)(?:\s|$)/.test(line) ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

function tooManyFiles(): ToolError {
  return new ToolError('TOO_MANY_FILES', `The folder holds more than ${MAX_FILES} .sql files.`, 'Point migrations at the folder of migrations only, or pass files with the ones to run.');
}

/**
 * Every .sql file under `dir` (real path), as paths relative to `base`, skipping secrets, down steps
 * (counted in `seen.down`, so an empty result can say why) and the setup file (`seen.setup`, its real
 * path), which runs once, as setup.
 */
function walk(root: Root, dir: string, base: string, out: string[], visited: Set<string>, seen: { down: number; setup: string | undefined }): void {
  if (visited.has(dir)) return; // a link loop
  visited.add(dir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw unreadable(toPosix(path.relative(root.real, dir)), err);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isSensitive(path.relative(root.real, full))) {
      // Never read, and never dropped in silence: a .sql file left out would be a migration the lint
      // did not run. Anything else (.git, an .env file) is not a migration anyway.
      if (entry.name.toLowerCase().endsWith('.sql')) {
        throw new ToolError(
          'SENSITIVE_PATH',
          `"${clipPath(toPosix(path.relative(root.real, full)))}" is named like a secret file (an .env file or a private key), so money-guard does not read it.`,
          'Rename the migration, or pass files without it.',
        );
      }
      continue;
    }
    let real = full;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // A link gets the same checks as a path argument (src/paths.ts): its real target must exist, lie
      // inside the project, not look like a secret and, for a file, be .sql. A hostile repository could
      // otherwise ship db/migrations/0002.sql pointing at ../../.env, and run the secrets as SQL.
      const shown = `"${clipPath(toPosix(path.relative(root.real, full)))}"`;
      try {
        real = realpathSync.native(full);
      } catch (err) {
        if (deniedOrLocked(err)) throw unreadable(toPosix(path.relative(root.real, full)), err);
        throw new ToolError('PATH_NOT_FOUND', `${shown} is a link to something that does not exist.`, 'Remove the broken link, or pass files with the migrations to run.');
      }
      if (!isInside(root.real, real)) {
        throw new ToolError('PATH_OUTSIDE_ROOT', `${shown} is a link to a place outside the project folder (${root.name}).`, 'Remove the link, or pass files with the migrations to run.');
      }
      if (isSensitive(path.relative(root.real, real))) {
        throw new ToolError('SENSITIVE_PATH', `${shown} is a link to a file that looks like a secret (an .env file, a private key or credentials).`, 'money-guard never reads secret files. Remove the link.');
      }
      try {
        const stat = statSync(real);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch (err) {
        throw unreadable(toPosix(path.relative(root.real, full)), err);
      }
      if (isFile && entry.name.toLowerCase().endsWith('.sql') && !real.toLowerCase().endsWith('.sql')) {
        throw new ToolError('FILE_TYPE_NOT_ALLOWED', `${shown} is a link to a file that is not .sql.`, 'Remove the link, or pass files with the migrations to run.');
      }
    }
    if (isDir) {
      walk(root, real, base, out, visited, seen);
    } else if (isFile && entry.name.toLowerCase().endsWith('.sql')) {
      if (isDownFile(entry.name)) {
        seen.down += 1;
        continue;
      }
      if (real === seen.setup) continue;
      out.push(toPosix(path.relative(base, full)));
      if (out.length > MAX_FILES) throw tooManyFiles();
    }
  }
}

function describeOtherFiles(dir: string): string {
  const counts = new Map<string, number>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase() || '(no extension)';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Most common first; ties by name, so the text is the same on every machine (readdir order is not).
  const list = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 5).map(([ext, n]) => `${n} ${clip(ext, 20)}`);
  return list.length === 0 ? 'It is empty.' : `It holds ${list.join(', ')} files.`;
}

/** Read a .sql file: the size limits, the hash, UTF-8, the format markers. */
function readScript(real: string, rel: string, size: number, budget: { total: number }, hash: ReturnType<typeof createHash>, failure: 'MIGRATION_FAILED' | 'SETUP_FAILED'): SqlScript {
  if (size > MAX_FILE_BYTES) {
    throw new ToolError('FILE_TOO_LARGE', `"${clipPath(rel)}" is ${formatSize(size)}; a migration file may be at most ${formatMib(MAX_FILE_BYTES)}.`, 'Split the file, or leave it out with files.');
  }
  budget.total += size;
  if (budget.total > MAX_TOTAL_BYTES) {
    throw new ToolError('FILE_TOO_LARGE', `The migrations together are over ${formatMib(MAX_TOTAL_BYTES)}.`, 'Pass files with the migrations to run, or point migrations at a smaller folder.');
  }
  const bytes = readChecked(real, rel);
  hash.update(rel).update('\0').update(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(failure, `"${clipPath(rel)}" is not valid UTF-8 text.`, 'Save the file as UTF-8.');
  }
  return { rel, text: prepareSql(text) };
}

export function collectSources(root: Root, args: { migrations: string; files?: readonly string[] | undefined; setup?: string | undefined }): Sources {
  const target = resolveInRoot(root, args.migrations, { kind: 'either', extensions: ['.sql'] });
  const folder = clipPath(target.rel); // as messages show it
  const hash = createHash('sha256');
  const budget = { total: 0 };

  let setup: SqlScript | null = null;
  let setupReal: string | undefined;
  if (args.setup !== undefined) {
    const s = resolveInRoot(root, args.setup, { kind: 'file', extensions: ['.sql'] });
    setup = readScript(s.real, s.rel, s.size, budget, hash, 'SETUP_FAILED');
    setupReal = s.real;
  }

  let chosen: Array<{ real: string; rel: string; size: number }>;
  if (!target.isDirectory) {
    if (args.files !== undefined) {
      throw new ToolError('FILE_NOT_IN_FOLDER', 'files can only be given when migrations is a folder.', 'Leave files out, or point migrations at the folder that holds them.');
    }
    chosen = [target];
  } else if (args.files !== undefined) {
    chosen = args.files.flatMap((entry) => {
      const notInFolder = new ToolError('FILE_NOT_IN_FOLDER', `"${clipPath(entry)}" is not a file in "${folder}".`, `Every entry of files is a path relative to "${folder}". Check the spelling.`);
      const lexical = path.resolve(target.real, entry);
      if (!isInside(target.real, lexical)) throw notInFolder;
      try {
        const f = resolveInRoot(root, toPosix(path.relative(root.real, lexical)), { kind: 'file', extensions: ['.sql'] });
        if (!isInside(target.real, f.real)) throw notInFolder;
        return f.real === setupReal ? [] : [f]; // the setup file runs once, as setup

      } catch (err) {
        if (err instanceof ToolError && (err.code === 'PATH_NOT_FOUND' || err.code === 'NOT_A_FILE')) throw notInFolder;
        throw err;
      }
    });
  } else {
    const found: string[] = [];
    const seen = { down: 0, setup: setupReal };
    walk(root, target.real, target.real, found, new Set(), seen);
    if (found.length === 0 && seen.down > 0) {
      const files = seen.down === 1 ? 'Its 1 .sql file is a down step' : `Its ${seen.down} .sql files are down steps`;
      throw new ToolError('NO_SQL_FILES', `"${folder}" holds no migrations to run. ${files} (down.sql, *.down.sql, *.undo.sql, *.rollback.sql), which money-guard leaves out.`, 'Point migrations at the folder of up migrations, or pass files with the ones to run.');
    }
    if (found.length === 0) {
      throw new ToolError('NO_SQL_FILES', `"${folder}" holds no .sql files. ${describeOtherFiles(target.real)}`, 'Migrations written as code (Knex, TypeORM) need SQL first: drizzle-kit generate, prisma migrate diff --script, or pg_dump --schema-only.');
    }
    found.sort(naturalCompare);
    chosen = found.map((rel) => {
      const shownRel = toPosix(path.relative(root.real, path.join(target.real, rel)));
      try {
        const real = realpathSync.native(path.join(target.real, rel));
        return { real, rel: shownRel, size: statSync(real).size };
      } catch (err) {
        throw unreadable(shownRel, err); // listed by the walk a moment ago: it is there, but cannot be read
      }
    });
  }

  const files = chosen.map((f) => readScript(f.real, f.rel, f.size, budget, hash, 'MIGRATION_FAILED'));
  return { migrations: target.rel, setup, files, sha256: hash.digest('hex') };
}
