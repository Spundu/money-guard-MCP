// Which migration files run, in which order, and as what text (SPEC.md §3.3). Only file-format markers
// are recognised, line by line: the up and down markers of tools that keep both directions in one file,
// and pg_dump's \restrict lines. The SQL itself is never parsed; Postgres runs it.

import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { quoted, quotedPath } from '../echo.js';
import { ToolError } from '../errors.js';
import { deniedOrLocked, formatMib, formatSize, isInside, isSensitive, leadsTo, readChecked, resolveInRoot, SQL_FIRST, tooManyLinks, toPosix, unreadable, type Root } from '../paths.js';

export const MAX_FILES = 2000;

/** Most files and folders the walk of a migrations folder visits: listing them blocks the server. */
export const MAX_ENTRIES = 10_000;

/**
 * Deepest a walk goes, in folders, links to folders included. Each level is a call: a chain of 3,000
 * folder links overflowed the stack (review round 9). Migrations sit one or two folders deep.
 */
export const MAX_DEPTH = 100;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface SqlScript {
  /** Relative to the project root, "/" separators: what results show. */
  rel: string;
  /** The SQL as it runs: down parts (after a known tool's down marker) and pg_dump's \restrict lines blanked. */
  text: string;
}

export interface Sources {
  /** The `migrations` argument, normalised. */
  migrations: string;
  setup: SqlScript | null;
  files: SqlScript[];
  /** SHA-256 over every applied file (path, NUL, bytes), setup first, then the migrations in order. */
  sha256: string;
  /** Whether migrations is one file, not a folder: files cannot pick from it, so advice must not say to. */
  single: boolean;
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
 * (manual)" in an ordinary file cuts nothing. node-pg-migrate runs only what lies between its first up
 * marker and the first down marker after it (`firstOnly`, as its getActions reads a file: review round 24).
 */
const TOOLS: ReadonlyArray<{ up: RegExp | null; down: RegExp; firstOnly?: true }> = [
  { up: /^--\s*migrate:up(?:\s|$)/, down: /^--\s*migrate:down(?:\s|$)/ },
  { up: /^--\s*\+goose\s+up(?:\s|$)/i, down: /^--\s*\+goose\s+down(?:\s|$)/i },
  { up: /^--\s*\+migrate\s+up(?:\s|$)/i, down: /^--\s*\+migrate\s+down(?:\s|$)/i },
  { up: /^\s*--[\s-]*up\s+migration/i, down: /^\s*--[\s-]*down\s+migration/i, firstOnly: true },
  { up: null, down: /^-{4}\s*create above\s*\/\s*drop below\s*-{4}/i },
];

/**
 * The SQL as it runs: the down part of a file that holds both directions, from a down marker to the
 * next up marker (or the end), becomes spaces, and so do lines starting \restrict or \unrestrict (psql
 * directives written by pg_dump 17.6 and later) and a line that only sets the client encoding, as pg_dump
 * writes it ("SET client_encoding = 'WIN1252';", or "SET NAMES"): the file was read as UTF-8 already, and
 * PGlite stops answering under any other encoding but LATIN1 and SQL_ASCII, and under those hangs on a
 * name that is not ASCII (review round 22: a schema dump of a Windows database could not be linted).
 * Every line keeps its length, so the positions Postgres reports still point at the right line and column.
 */
/** A line that only sets the client encoding, as pg_dump writes it. */
const CLIENT_ENCODING = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?(?:client_encoding\s*(?:=|TO)|NAMES)\s*[^;]*;\s*(?:--.*)?$/i; // a comment after it, LOCAL (round 23)

/**
 * pg_dump's line that empties the search path. The dump names every object with its schema, so it does nothing
 * there; it emptied the search path of every later file, whose unqualified names then failed (review round 23).
 */
const EMPTY_SEARCH_PATH = /^\s*SELECT\s+pg_catalog\.set_config\('search_path',\s*'',\s*false\);\s*$/i;

export function prepareSql(text: string): string {
  const lines = text.split('\n');
  const tool = TOOLS.find((t) => lines.some((line) => (t.up ?? t.down).test(line)));
  const upAt = tool?.firstOnly === true && tool.up !== null ? lines.findIndex((line) => tool.up?.test(line)) : -1;
  const downAt = upAt < 0 ? -1 : lines.findIndex((line, i) => i > upAt && tool?.down.test(line));
  let down = false;
  return lines
    .map((line, i) => {
      if (upAt >= 0) down = i < upAt || (downAt >= 0 && i >= downAt); // what node-pg-migrate never runs
      else if (tool?.up?.test(line)) down = false;
      else if (tool?.down.test(line)) down = true;
      return down || /^\\(?:restrict|unrestrict)(?:\s|$)/.test(line) || CLIENT_ENCODING.test(line) || EMPTY_SEARCH_PATH.test(line) ? ' '.repeat(line.length) : line;
    })
    .join('\n');
}

/** What a walk has met so far: for its limits, and so an empty result can say why. */
interface Seen {
  /** Down steps left out. */
  down: number;
  /** The setup file's real path: it runs once, as setup. */
  setup: string | undefined;
  setupFound: boolean;
  /** Files and folders met, against MAX_ENTRIES. */
  entries: number;
  /** Files that are not .sql, by extension, subfolders included. */
  others: Map<string, number>;
}

function countOther(seen: Seen, name: string): void {
  const ext = path.extname(name).toLowerCase() || '(no extension)';
  seen.others.set(ext, (seen.others.get(ext) ?? 0) + 1);
}

function tooManyFiles(): ToolError {
  return new ToolError('TOO_MANY_FILES', `The folder holds more than ${MAX_FILES.toLocaleString('en-GB')} .sql files.`, 'Point migrations at the folder of migrations only. To lint them all, lint one schema-only dump of the database they build (pg_dump --schema-only): the files parameter cannot hold more than 2,000 either.');
}

/**
 * Every .sql file under `dir` (real path), as paths relative to `base`, skipping secrets, down steps
 * (counted in `seen.down`, so an empty result can say why) and the setup file (`seen.setup`, its real
 * path), which runs once, as setup.
 */
function walk(root: Root, dir: string, base: string, out: string[], visited: Set<string>, seen: Seen, depth = 0): void {
  if (visited.has(dir)) return; // a link loop
  visited.add(dir);
  if (depth > MAX_DEPTH) {
    throw new ToolError(
      'TOO_MANY_FILES',
      `The folder nests folders (or links to folders) more than ${MAX_DEPTH} deep; money-guard looks no deeper for migrations.`,
      'Point migrations at the folder of migrations only, or pass files with the ones to run.',
    );
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw unreadable(toPosix(path.relative(root.real, dir)), err);
  }
  for (const entry of entries) {
    seen.entries += 1;
    if (seen.entries > MAX_ENTRIES) {
      throw new ToolError(
        'TOO_MANY_FILES',
        `The folder holds more than ${MAX_ENTRIES.toLocaleString('en-GB')} files and folders; money-guard looks through at most that many for migrations.`,
        'Point migrations at the folder of migrations only, or pass files with the ones to run.',
      );
    }
    const full = path.join(dir, entry.name);
    if (isSensitive(path.relative(root.real, full))) {
      // Never read, and never dropped in silence: a .sql file left out would be a migration the lint
      // did not run. Anything else (.git, an .env file) is not a migration anyway.
      if (entry.name.toLowerCase().endsWith('.sql')) {
        throw new ToolError(
          'SENSITIVE_PATH',
          `${quotedPath(toPosix(path.relative(root.real, full)))} is named like a secret file (an .env file or a private key), so money-guard does not read it.`,
          'Rename the migration, or pass files without it.',
        );
      }
      if (entry.isFile()) countOther(seen, entry.name);
      continue;
    }
    let real = full;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // A link gets the same checks as a path argument (src/paths.ts): its real target must exist, lie
      // inside the project, not look like a secret and, for a file, be .sql. A hostile repository could
      // otherwise ship db/migrations/0002.sql pointing at ../../.env, and run the secrets as SQL.
      const shown = quotedPath(toPosix(path.relative(root.real, full)));
      const outside = () => new ToolError('PATH_OUTSIDE_ROOT', `${shown} is a link to a place outside the project folder "${root.name}".`, 'Remove the link, or pass files with the migrations to run.');
      // Where it leads, read before it is followed: realpath would open a share it points at (review round 19).
      const leads = leadsTo(full, root.real, root.links);
      if (leads === null) throw tooManyLinks(toPosix(path.relative(root.real, full)));
      if (!isInside(root.real, leads)) throw outside();
      try {
        real = realpathSync.native(full);
      } catch (err) {
        // A broken link that leads outside gets the answer one to a place that exists there would.
        const target = leadsTo(full, root.real, root.links);
        if (target === null) throw tooManyLinks(toPosix(path.relative(root.real, full)));
        if (isInside(root.real, target)) {
          if (deniedOrLocked(err)) throw unreadable(toPosix(path.relative(root.real, full)), err);
          throw new ToolError('PATH_NOT_FOUND', `${shown} is a link to something that does not exist.`, 'Remove the broken link, or pass files with the migrations to run.');
        }
        throw outside();
      }
      if (!isInside(root.real, real)) throw outside();
      if (isSensitive(path.relative(root.real, real))) {
        throw new ToolError('SENSITIVE_PATH', `${shown} is a link to a file or folder that looks like a secret (an .env file, a private key, credentials or the .git folder).`, 'money-guard never reads secret files. Remove the link.');
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
      walk(root, real, base, out, visited, seen, depth + 1);
    } else if (isFile && entry.name.toLowerCase().endsWith('.sql')) {
      if (isDownFile(entry.name)) {
        seen.down += 1;
        continue;
      }
      if (real === seen.setup) {
        seen.setupFound = true;
        continue;
      }
      out.push(toPosix(path.relative(base, full)));
      if (out.length > MAX_FILES) throw tooManyFiles();
    } else if (isFile) {
      countOther(seen, entry.name);
    }
  }
}

/** What a folder without .sql files holds instead, subfolders included: its five most common file types. */
function describeOtherFiles(seen: Seen): string {
  // Most common first; ties by name, so the text is the same on every machine (readdir order is not).
  const top = [...seen.others].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 5);
  if (top.length === 0) return seen.entries === 0 ? 'It is empty.' : 'It holds folders but no files.';
  const kinds = top.map(([ext, n]) => `${n} ${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : quoted(ext, 20)} ${n === 1 ? 'file' : 'files'}`); // an odd one in quotes (review round 11)
  const last = kinds.pop() ?? '';
  return `It holds ${kinds.length === 0 ? last : `${kinds.join(', ')} and ${last}`}.`;
}

/**
 * Read a .sql file: the size limits, the hash, UTF-8, the format markers. `role`: the setup file, a
 * migration in a folder, or the one file migrations names (which files cannot leave out).
 */
function readScript(real: string, rel: string, size: number, budget: { total: number }, hash: ReturnType<typeof createHash>, role: 'setup' | 'folder' | 'single'): SqlScript {
  if (size > MAX_FILE_BYTES) {
    const fix = { setup: 'Keep only what the migrations need in the setup file.', folder: 'Split the file, or leave it out with files.', single: 'Split the file into a folder of smaller files, and lint the folder.' }[role];
    throw new ToolError('FILE_TOO_LARGE', `${quotedPath(rel)} is ${formatSize(size)}; a .sql file may be at most ${formatMib(MAX_FILE_BYTES)}.`, fix);
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
    throw new ToolError(role === 'setup' ? 'SETUP_FAILED' : 'MIGRATION_FAILED', `${quotedPath(rel)} is not valid UTF-8 text.`, 'Save the file as UTF-8.');
  }
  return { rel, text: prepareSql(text) };
}

export function collectSources(root: Root, args: { migrations: string; files?: readonly string[] | undefined; setup?: string | undefined }): Sources {
  const target = resolveInRoot(root, args.migrations, { kind: 'either', extensions: ['.sql'] });
  const folder = quotedPath(target.rel); // as messages show it, in quotes
  const hash = createHash('sha256');
  const budget = { total: 0 };

  let setup: SqlScript | null = null;
  let setupReal: string | undefined;
  if (args.setup !== undefined) {
    const s = resolveInRoot(root, args.setup, { kind: 'file', extensions: ['.sql'] });
    setup = readScript(s.real, s.rel, s.size, budget, hash, 'setup');
    setupReal = s.real;
  }

  // The setup file runs once, as setup, never as a migration too, however it is named: files cannot help.
  const SETUP_ONLY_FIX = 'Point migrations at the migrations, and setup at the file to run before them.';
  const onlySetup = (where: string) =>
    new ToolError('NO_SQL_FILES', `${folder} holds no migrations to run: ${where} the setup file, which runs once, as setup.`, SETUP_ONLY_FIX);
  let chosen: Array<{ real: string; rel: string; size: number }>;
  if (!target.isDirectory) {
    if (target.real === setupReal) throw onlySetup('it is');
    if (args.files !== undefined) {
      throw new ToolError('FILE_NOT_IN_FOLDER', 'files can only be given when migrations is a folder.', 'Leave files out, or point migrations at the folder that holds them.');
    }
    chosen = [target];
  } else if (args.files !== undefined) {
    chosen = args.files.flatMap((entry) => {
      // An entry written from the project root, as a model may write it (review round 16). Not "./" of the
      // root itself (round 17), and only when the shorter path is a migration in the folder (round 18),
      // looked up as any path argument is, so a shorter path that is absolute, a share (//host/share) or
      // climbs out with ".." is refused before anything is touched (review round 19: it reached any file,
      // pipe or share, and the answer told whether it existed).
      const fromRoot = () => {
        const shorter = toPosix(entry).slice(target.rel.length + 1);
        if (!toPosix(entry).startsWith(`${target.rel}/`)) return false; // under ".", "./x.sql" and "x.sql" are the same file
        try {
          return isInside(target.real, resolveInRoot(root, toPosix(path.relative(root.real, path.resolve(target.real, shorter))), { kind: 'file', extensions: ['.sql'] }).real);
        } catch {
          return false;
        }
      };
      const notInFolder = () => new ToolError('FILE_NOT_IN_FOLDER', `${quotedPath(entry)} is not a file in ${folder}.`, fromRoot() ? `Every entry of files is a path relative to ${folder}: leave out the leading ${quotedPath(`${target.rel}/`)}.` : `Every entry of files is a path relative to ${folder}. Check the spelling.`);
      const lexical = path.resolve(target.real, entry);
      if (!isInside(target.real, lexical)) throw notInFolder();
      try {
        const f = resolveInRoot(root, toPosix(path.relative(root.real, lexical)), { kind: 'file', extensions: ['.sql'] });
        if (!isInside(target.real, f.real)) throw notInFolder();
        return f.real === setupReal ? [] : [f]; // the setup file runs once, as setup
      } catch (err) {
        if (err instanceof ToolError && (err.code === 'PATH_NOT_FOUND' || err.code === 'NOT_A_FILE')) throw notInFolder();
        // Named as the entry was written, with what to do in files (review round 19: it was told to pass a folder).
        if (err instanceof ToolError && err.code === 'FILE_TYPE_NOT_ALLOWED') throw new ToolError('FILE_TYPE_NOT_ALLOWED', `${quotedPath(toPosix(entry))} in files is not a .sql file.`, 'Leave it out of files: only .sql migrations run.');
        throw err;
      }
    });
    // A file named twice would run twice, and then look as if it created its objects twice (review round 12).
    const twice = chosen.find((f, i) => chosen.findIndex((g) => g.real === f.real) !== i);
    if (twice !== undefined) {
      throw new ToolError('FILE_NOT_IN_FOLDER', `${quotedPath(twice.rel)} is named twice in files: each file runs once.`, 'Name each file once.');
    }
    if (chosen.length === 0) throw onlySetup('files names only');
  } else {
    const found: string[] = [];
    const seen: Seen = { down: 0, setup: setupReal, setupFound: false, entries: 0, others: new Map() };
    walk(root, target.real, target.real, found, new Set(), seen);
    if (found.length === 0 && (seen.down > 0 || seen.setupFound)) {
      const left: string[] = [];
      if (seen.down > 0) left.push(`${seen.down === 1 ? '1 .sql file is a down step' : `${seen.down} .sql files are down steps`} (down.sql, *.down.sql, *.undo.sql, *.rollback.sql), which money-guard leaves out`);
      if (seen.setupFound) left.push('the setup file runs once, as setup');
      throw new ToolError('NO_SQL_FILES', `${folder} holds no migrations to run: ${left.join('; ')}.`, seen.down > 0 ? 'Point migrations at the folder of up migrations, or pass files with the ones to run.' : SETUP_ONLY_FIX);
    }
    if (found.length === 0) {
      throw new ToolError('NO_SQL_FILES', `${folder} holds no .sql files. ${describeOtherFiles(seen)}`, `Check that migrations points at the folder of migrations. ${SQL_FIRST}`);
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

  const single = !target.isDirectory;
  const files = chosen.map((f) => readScript(f.real, f.rel, f.size, budget, hash, single ? 'single' : 'folder'));
  return { migrations: target.rel, setup, files, sha256: hash.digest('hex'), single };
}
