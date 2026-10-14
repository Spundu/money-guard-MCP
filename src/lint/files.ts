// Which migration files run, in which order, and as what text (SPEC.md §3.3). Only file-format markers
// are recognised, line by line: dbmate's "-- migrate:down" and pg_dump's \restrict lines. The SQL
// itself is never parsed; Postgres runs it.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import { formatMib, isInside, isSensitive, resolveInRoot, toPosix, type Root } from '../paths.js';

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

/** golang-migrate and Diesel "down" steps, which would undo the schema if they ran. */
function isDownFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'down.sql' || lower.endsWith('.down.sql');
}

/**
 * The SQL as it runs. A line starting "-- migrate:down" ends a dbmate file's up part. Lines starting
 * \restrict or \unrestrict (psql directives written by pg_dump 17.6 and later) become spaces of the same
 * length, so the positions Postgres reports still point at the right line and column.
 */
export function prepareSql(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^--\s*migrate:down/.test(line)) break;
    out.push(/^\\(?:restrict|unrestrict)(?:\s|$)/.test(line) ? ' '.repeat(line.length) : line);
  }
  return out.join('\n');
}

function tooManyFiles(): ToolError {
  return new ToolError('TOO_MANY_FILES', `The folder holds more than ${MAX_FILES} .sql files.`, 'Point migrations at the folder of migrations only, or pass files with the ones to run.');
}

/** Every .sql file under `dir` (real path), as paths relative to `base`, skipping secrets and down steps. */
function walk(root: Root, dir: string, base: string, out: string[], visited: Set<string>): void {
  if (visited.has(dir)) return; // a link loop
  visited.add(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (isSensitive(path.relative(root.real, full))) continue;
    let real = full;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // A link gets the same checks as a path argument (src/paths.ts): its real target must exist, lie
      // inside the project, not look like a secret and, for a file, be .sql. A hostile repository could
      // otherwise ship db/migrations/0002.sql pointing at ../../.env, and run the secrets as SQL.
      const shown = `"${clip(toPosix(path.relative(root.real, full)), 120)}"`;
      try {
        real = realpathSync.native(full);
      } catch {
        throw new ToolError('PATH_NOT_FOUND', `${shown} is a link to something that does not exist.`, 'Remove the broken link, or pass files with the migrations to run.');
      }
      if (!isInside(root.real, real)) {
        throw new ToolError('PATH_OUTSIDE_ROOT', `${shown} is a link to a place outside the project folder (${root.name}).`, 'Remove the link, or pass files with the migrations to run.');
      }
      if (isSensitive(path.relative(root.real, real))) {
        throw new ToolError('SENSITIVE_PATH', `${shown} is a link to a file that looks like a secret (an .env file, a private key or credentials).`, 'money-guard never reads secret files. Remove the link.');
      }
      const stat = statSync(real);
      isDir = stat.isDirectory();
      isFile = stat.isFile();
      if (isFile && entry.name.toLowerCase().endsWith('.sql') && !real.toLowerCase().endsWith('.sql')) {
        throw new ToolError('FILE_TYPE_NOT_ALLOWED', `${shown} is a link to a file that is not .sql.`, 'Remove the link, or pass files with the migrations to run.');
      }
    }
    if (isDir) {
      walk(root, real, base, out, visited);
    } else if (isFile && entry.name.toLowerCase().endsWith('.sql') && !isDownFile(entry.name)) {
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
  const list = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ext, n]) => `${n} ${clip(ext, 20)}`);
  return list.length === 0 ? 'It is empty.' : `It holds ${list.join(', ')} files.`;
}

/** Read a .sql file: the size limits, the hash, UTF-8, the format markers. */
function readScript(real: string, rel: string, size: number, budget: { total: number }, hash: ReturnType<typeof createHash>): SqlScript {
  if (size > MAX_FILE_BYTES) {
    throw new ToolError('FILE_TOO_LARGE', `"${clip(rel, 120)}" is ${formatMib(size)}; a migration file may be at most ${formatMib(MAX_FILE_BYTES)}.`, 'Split the file, or leave it out with files.');
  }
  budget.total += size;
  if (budget.total > MAX_TOTAL_BYTES) {
    throw new ToolError('FILE_TOO_LARGE', `The migrations together are over ${formatMib(MAX_TOTAL_BYTES)}.`, 'Pass files with the migrations to run, or point migrations at a smaller folder.');
  }
  const bytes = readFileSync(real);
  hash.update(rel).update('\0').update(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError('MIGRATION_FAILED', `"${clip(rel, 120)}" is not valid UTF-8 text.`, 'Save the file as UTF-8.');
  }
  return { rel, text: prepareSql(text) };
}

export function collectSources(root: Root, args: { migrations: string; files?: readonly string[] | undefined; setup?: string | undefined }): Sources {
  const target = resolveInRoot(root, args.migrations, { kind: 'either', extensions: ['.sql'] });
  const hash = createHash('sha256');
  const budget = { total: 0 };

  let setup: SqlScript | null = null;
  if (args.setup !== undefined) {
    const s = resolveInRoot(root, args.setup, { kind: 'file', extensions: ['.sql'] });
    setup = readScript(s.real, s.rel, s.size, budget, hash);
  }

  let chosen: Array<{ real: string; rel: string; size: number }>;
  if (!target.isDirectory) {
    if (args.files !== undefined) {
      throw new ToolError('FILE_NOT_IN_FOLDER', 'files can only be given when migrations is a folder.', 'Leave files out, or point migrations at the folder that holds them.');
    }
    chosen = [target];
  } else if (args.files !== undefined) {
    chosen = args.files.map((entry) => {
      const notInFolder = new ToolError('FILE_NOT_IN_FOLDER', `"${clip(entry, 120)}" is not a file in "${target.rel}".`, `Every entry of files is a path relative to "${target.rel}". Check the spelling.`);
      const lexical = path.resolve(target.real, entry);
      if (!isInside(target.real, lexical)) throw notInFolder;
      try {
        const f = resolveInRoot(root, path.relative(root.real, lexical), { kind: 'file', extensions: ['.sql'] });
        if (!isInside(target.real, f.real)) throw notInFolder;
        return f;
      } catch (err) {
        if (err instanceof ToolError && (err.code === 'PATH_NOT_FOUND' || err.code === 'NOT_A_FILE')) throw notInFolder;
        throw err;
      }
    });
  } else {
    const found: string[] = [];
    walk(root, target.real, target.real, found, new Set());
    if (found.length === 0) {
      throw new ToolError('NO_SQL_FILES', `"${target.rel}" holds no .sql files. ${describeOtherFiles(target.real)}`, 'Migrations written as code (Knex, TypeORM) need SQL first: drizzle-kit generate, prisma migrate diff --script, or pg_dump --schema-only.');
    }
    found.sort(naturalCompare);
    chosen = found.map((rel) => {
      const real = realpathSync.native(path.join(target.real, rel));
      return { real, rel: toPosix(path.relative(root.real, path.join(target.real, rel))), size: statSync(real).size };
    });
  }

  const files = chosen.map((f) => readScript(f.real, f.rel, f.size, budget, hash));
  return { migrations: target.rel, setup, files, sha256: hash.digest('hex') };
}
