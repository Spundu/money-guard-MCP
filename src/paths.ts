// Which files the tools may read (SPEC.md §2.3). Every path argument goes through resolveInRoot; the
// migration-folder walk (lint/files.ts) uses the same checks for every file it finds.
//
// The order of the checks matters: a path that is outside the project is refused BEFORE the file system
// is touched, so the answer never reveals whether something outside the project exists; through a link
// that leads outside, a path that exists and one that does not get the same answer.

import { opendirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clip, ECHO_MAX, NAME_MAX, quoted, quotedPath } from './echo.js';
import { ToolError } from './errors.js';
import { isInside, leadsTo, MAX_LINK_HOPS, MAX_LINK_PARTS, type LinkWalk } from './links.js';

export { isInside, leadsTo, newLinkWalk, type LinkWalk } from './links.js';

/** What to do with migrations written as code, in the fixes that meet them (the README gives the same routes; review round 21). */
export const SQL_FIRST = "Migrations written as code (Knex, TypeORM, Django, Alembic) need SQL first: their tool's SQL output (prisma migrate diff --script, drizzle-kit generate, alembic upgrade head --sql, python manage.py sqlmigrate <app> <migration> for each one), or pg_dump --schema-only of a database they built.";

/** The project folder, already resolved to its real path (config.ts). */
export interface Root {
  /** Absolute real path. Never shown in a result or an error. */
  real: string;
  /** Its folder name, the only part of it that messages show: escaped and cut (`clip`), a double quote in it escaped, so that messages put it in quotes (review round 17: unquoted, a name could add a "Fix:" of its own). */
  name: string;
  /** What this call has learned of the links on its paths (one per tool call; without it, each path is followed on its own). */
  links?: LinkWalk;
}

export interface PathRule {
  /** 'either': a folder, or a file with an allowed extension (a migrations folder or one schema file). */
  kind: 'file' | 'either';
  /** Allowed extensions for a file, lowercase with the dot (".csv"). */
  extensions?: readonly string[];
  /** Largest file accepted, in bytes. */
  maxBytes?: number;
}

export interface ResolvedPath {
  /** Absolute real path, for reading. Never shown. */
  real: string;
  /** Relative to the root with "/" separators ("." for the root itself), for results. */
  rel: string;
  /** Size in bytes (files). */
  size: number;
  isDirectory: boolean;
}

const MAX_PATH_CHARS = 1024;
const MIB = 1024 * 1024;

/** "/"-separated form of a relative path, the form every result uses. */
export function toPosix(rel: string): string {
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/** `text` with `sep` between camelCase words, also after an acronym: "AWSCredentials" is "AWS_Credentials". */
export function splitCamel(text: string, sep: string): string {
  return text.replace(/([a-z0-9])([A-Z])|([A-Z])(?=[A-Z][a-z])/g, (_m, a: string | undefined, b: string | undefined, c: string | undefined) => (c === undefined ? `${a}${sep}${b}` : `${c}${sep}`));
}

const CREDENTIAL_FOLDERS: ReadonlySet<string> = new Set(['.aws', '.azure', '.gcloud', 'gcloud', '.kube', '.ssh', 'configstore', 'legacy_credentials']);

/** The folder of `rel` where command-line tools keep their logins, when `rel` is a ledger-type file in one. */
export function credentialFolder(rel: string): string | undefined {
  const raw = rel.split(/[\\/]/);
  if (!/\.(?:csv|tsv|json|jsonl|ndjson)$/i.test(raw.at(-1) ?? '')) return undefined;
  return raw.slice(0, -1).find((s) => CREDENTIAL_FOLDERS.has(s.toLowerCase()));
}

/**
 * Names the tools refuse at any depth: environment files, private keys and certificates, package-manager
 * and git credentials, cloud credential downloads (ledger-type files: AWS access-key CSVs, Google
 * client secrets and service-account keys, key.json and *-key.json, auth.json, access tokens, credentials
 * and secrets files), and anything inside .git
 * (SPEC.md §2.3). Compared in lower case. The credential words only count in ledger-type names (.csv,
 * .tsv, .json, .jsonl, .ndjson): a migration such as 0002_create_access_keys.sql, or a folder add_service_accounts, is not a secret.
 */
export function isSensitive(rel: string): boolean {
  const raw = rel.split(/[\\/]/);
  const segments = raw.map((s) => s.toLowerCase());
  if (segments.includes('.git')) return true;
  // The folders where command-line tools keep their logins (review round 18: gcloud's adc.json, the Azure
  // CLI's token cache): any ledger-type file in them.
  if (credentialFolder(rel) !== undefined) return true;
  // Azure Functions' local secrets, and Docker's registry logins (review round 12).
  if (segments.at(-1) === 'local.settings.json' || (segments.at(-1) === 'config.json' && segments.at(-2) === '.docker')) return true;
  // A copy is the same file: " (1)", Windows' " - Copy (2)", macOS's " copy 2" and "Copy of " are left
  // out, a copy of a copy too, so until nothing changes (review rounds 15-17; each pass shortens the
  // name, so this ends). camelCase words are words too, also after an acronym ("awsCredentials.csv",
  // "AWSCredentials.csv"); both forms are tried, as "KeePass" and "GitHub" are one word each.
  let last = raw.at(-1) ?? '';
  for (let before = ''; before !== last; ) {
    before = last;
    last = last.replace(/^copy of /i, '').replace(/(?: - copy(?: \(\d+\))?| copy(?: \d+)?| ?\(\d+\))(?=\.[^.]+$)/i, '');
  }
  return [last.toLowerCase(), splitCamel(last, '_').toLowerCase()].some(sensitiveName);
}

/** Whether a file name, in lower case, is one isSensitive refuses. */
function sensitiveName(base: string): boolean {
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    ['.npmrc', '.pypirc', '.netrc', '.git-credentials'].includes(base) ||
    base.startsWith('id_rsa') ||
    base.startsWith('id_ed25519') ||
    ['.pem', '.key', '.p12', '.pfx', '.keystore'].some((ext) => base.endsWith(ext)) ||
    // Every type the ledger tool reads; logins and keystore as the export names only, as wallet and logins
    // also name ledgers (review round 13: wallet_transactions.csv was refused), with what a second download
    // or a copy adds (review round 14: logins (1).csv, logins-2026-10-16.csv). Words are bounded by anything
    // but a letter or digit, and a space joins two-word names (review round 15: "Bitwarden Export.json").
    (/\.(?:csv|tsv|json|jsonl|ndjson)$/.test(base) &&
      (/^(?:logins|keystore)(?:[ _-]+(?:\d+|backup|export|copy)|[ _-]*\(\d+\))*\.(?:csv|json)$|(?:^|[^a-z])(?:passwords?|credentials?)(?:[^a-z]|$)|(?:^|[^a-z0-9])(?:secrets?|creds|bitwarden|lastpass|1password|keepass|dashlane|private[-_ ]?keys?|secret[-_ ]?keys?|(?:access|auth|api|github|bearer|refresh|id)[-_ ]?tokens?)(?:[^a-z0-9]|$)|^\.?secrets[._-]|api[-_ ]?keys?|access[-_ ]?keys?|keyfile|oauth[-_ ]?tokens?|accesstokens|rootkey|client_secret|service[-_ ]?account|adminsdk|^tokens?\.json$|(?:^|[-_.])tokens?(?:[-_]cache)?\.json$|token[-_]?cache|creds?\.json$|^auth\.json$|(?:^|[-_.])key\.json$/.test(base) ||
        // a Google Cloud key as downloaded: the project's name, then 12 hex digits with at least one letter
        /-(?=[0-9a-f]*[a-f])[0-9a-f]{12}\.json$/.test(base)))
  );
}

function shown(input: string): string {
  return quotedPath(input);
}

function checkSyntax(input: string): void {
  const invalid = (why: string) =>
    new ToolError('PATH_INVALID', `The path ${shown(input)} ${why}.`, 'Pass a path relative to the project root, such as "db/migrations".');
  if (input.length === 0) throw invalid('is empty');
  if (input.length > MAX_PATH_CHARS) throw invalid(`is longer than ${MAX_PATH_CHARS} characters`);
  if (input.includes('\0')) throw invalid('contains a NUL character');
  // UNC shares (\\server\share) and Windows device paths (\\?\, \\.\), and their "//" spellings.
  if (/^[\\/]{2}/.test(input)) throw invalid('is a network or device path');
  // On Windows a colon anywhere but after a drive letter names an alternate data stream ("a.csv:hidden").
  if (process.platform === 'win32' && input.slice(/^[A-Za-z]:/.test(input) ? 2 : 0).includes(':')) {
    throw invalid('contains a colon');
  }
}

function checkSensitive(input: string, rel: string): void {
  // A billing export saved in gcloud/ is refused for its folder: name it, and the way out (review round 19).
  const folder = credentialFolder(rel);
  if (folder !== undefined) {
    throw new ToolError(
      'SENSITIVE_PATH',
      `${shown(input)} is inside ${quoted(folder, NAME_MAX)}, a folder where command-line tools keep their logins.`,
      'money-guard reads no ledger-type file there. Copy the export to another folder of the project, then pass that path.',
    );
  }
  if (isSensitive(rel)) {
    throw new ToolError(
      'SENSITIVE_PATH',
      `${shown(input)} looks like a secrets file (an .env file, a private key or credentials).`,
      'money-guard never reads secret files. Point it at migrations, ledger exports or audit logs.',
    );
  }
}

function checkExtension(root: Root, input: string, rel: string, rule: PathRule): void {
  const extensions = rule.extensions ?? [];
  const ext = path.extname(rel).toLowerCase();
  if (!extensions.includes(ext)) {
    // A migration written as code needs SQL first, as NO_SQL_FILES says for a folder (review round 18):
    // said for migrations only, which take a folder or a file; setup takes one file (round 19).
    const code = rule.kind === 'either' && extensions.includes('.sql') && /^\.(?:[cm]?[jt]s|py|rb|go|java|kt|php|cs|ex|exs)$/.test(ext);
    throw new ToolError(
      'FILE_TYPE_NOT_ALLOWED',
      `${shown(input)} is not one of the file types this tool reads.`,
      code
        ? `Pass a folder of .sql migrations, or one .sql file, inside the project folder "${root.name}". ${SQL_FIRST}`
        : `Pass a file ending in ${extensions.join(', ')} inside the project folder "${root.name}".`,
    );
  }
}

/**
 * The closest folder above `lexical` that exists: as it is shown (relative to the root, "." for the
 * root), and where it really is, which a link on the way may put outside the project.
 */
function nearestExisting(root: Root, lexical: string): { shown: string; real: string } {
  let dir = path.dirname(lexical);
  while (isInside(root.real, dir)) {
    try {
      if (statSync(dir).isDirectory()) return { shown: toPosix(path.relative(root.real, dir)), real: realpathSync.native(dir) };
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { shown: '.', real: root.real };
}

/** Most entries of a folder a PATH_NOT_FOUND names, and most it reads to find them. */
const HELD_SHOWN = 20;
const HELD_READ = 10_000;

/**
 * ", which holds: \"journal.csv\", \"q3/\"": the folders and the files of the tool's types in the nearest
 * existing folder, so a host with no tool to list files (Claude Desktop) can find an export by name (a live
 * test, 2026-10-18: a model guessed four names and gave up). Never a link, a secret or a credential folder's
 * file; each name cut at 40 characters, in code-unit order; and at most HELD_READ entries are read.
 */
function whatItHolds(root: Root, near: { shown: string; real: string }, rule: PathRule): string {
  const extensions = rule.extensions ?? [];
  const names: string[] = [];
  let read = 0;
  let dir;
  try {
    dir = opendirSync(near.real);
    for (let entry = dir.readSync(); entry !== null && read < HELD_READ; entry = dir.readSync(), read += 1) {
      const rel = toPosix(path.relative(root.real, path.join(near.real, entry.name)));
      if (isSensitive(rel)) continue;
      if (entry.isDirectory()) names.push(`${entry.name}/`);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) names.push(entry.name);
    }
  } catch {
    return ''; // a folder that cannot be listed: the error says no more than it did before
  } finally {
    dir?.closeSync();
  }
  if (names.length === 0) return `, which holds no folder and no ${extensions.join(', ')} file`;
  names.sort();
  const more = read >= HELD_READ ? ' and more' : names.length > HELD_SHOWN ? ` and ${names.length - HELD_SHOWN} more` : '';
  return `, which holds: ${names.slice(0, HELD_SHOWN).map((n) => quoted(n, ECHO_MAX)).join(', ')}${more}`;
}

/** For a path whose links go round, or chain past MAX_LINK_HOPS: nothing about where they lead. */
export function tooManyLinks(input: string): ToolError {
  return new ToolError('PATH_NOT_FOUND', `${shown(input)} goes through more links than can be followed (a loop, a chain of more than ${MAX_LINK_HOPS}, or more parts of link texts than one call reads, ${MAX_LINK_PARTS.toLocaleString('en-GB')}).`, 'Remove the loop, or shorten the chain of links.');
}

function linkOutside(root: Root, input: string): ToolError {
  return new ToolError('PATH_OUTSIDE_ROOT', `${shown(input)} is a link to a place outside the project folder "${root.name}".`, 'Pass a file or folder that really lives inside the project.');
}

/**
 * Resolve a path argument and check it against every rule of SPEC.md §2.3. Throws a ToolError naming the
 * first rule it breaks; returns the real path to read and the relative path to show.
 */
export function resolveInRoot(root: Root, input: string, rule: PathRule): ResolvedPath {
  checkSyntax(input);

  const lexical = path.resolve(root.real, input);
  if (!isInside(root.real, lexical)) {
    // On Windows, a path that starts with one "/" begins at the root of the current drive, so a Git
    // Bash path (/c/Users/..., /tmp/...) lands outside the project even when it means a place inside.
    const gitBash = process.platform === 'win32' && input.startsWith('/') && !input.startsWith('//');
    throw new ToolError(
      'PATH_OUTSIDE_ROOT',
      `${shown(input)} is outside the project folder "${root.name}".`,
      `Pass a path inside the project, relative to its root.${gitBash ? ' On Windows a path that starts with "/" begins at the root of the drive: Git Bash paths such as /c/Users/... are not understood.' : ''}`,
    );
  }
  const lexRel = path.relative(root.real, lexical);
  checkSensitive(input, lexRel);
  // A file rule refuses the wrong type before touching the disk; 'either' must first learn what it is.
  // A name with no extension at all may be a folder: the disk says which (NOT_A_FILE), and a file of that
  // name is refused after it (review round 12: a folder was "not one of the file types").
  if (rule.kind === 'file' && rule.extensions && path.extname(lexRel) !== '') checkExtension(root, input, lexRel, rule);

  // Where the links lead, read before any is followed: realpath would open a share a link points at.
  const leads = leadsTo(lexical, root.real, root.links);
  if (leads === null) throw tooManyLinks(input);
  if (!isInside(root.real, leads)) throw linkOutside(root, input);

  let real: string;
  try {
    real = realpathSync.native(lexical);
  } catch (err) {
    // Through a link that leads out of the project, whether the rest of the path exists would say what
    // is there: the answer is the same either way.
    const near = nearestExisting(root, lexical);
    const target = leadsTo(lexical, root.real, root.links);
    if (target === null) throw tooManyLinks(input); // the same answer, wherever the chain ends (review round 10)
    if (!isInside(root.real, near.real) || !isInside(root.real, target)) throw linkOutside(root, input);
    if (deniedOrLocked(err)) throw unreadable(toPosix(lexRel), err);
    throw new ToolError(
      'PATH_NOT_FOUND',
      `${shown(input)} does not exist. The nearest existing folder is ${quotedPath(near.shown)}${whatItHolds(root, near, rule)}.`,
      `Check the spelling. Paths are relative to the project folder "${root.name}".`,
    );
  }
  // A link inside the project may point outside it: the REAL target is what gets read.
  if (!isInside(root.real, real)) throw linkOutside(root, input);
  const realRel = path.relative(root.real, real);
  checkSensitive(input, realRel);

  let stat: Stats;
  try {
    stat = statSync(real);
  } catch (err) {
    throw unreadable(toPosix(lexRel), err);
  }
  if (rule.kind === 'file' && !stat.isFile()) {
    throw new ToolError('NOT_A_FILE', `${shown(input)} is not a file.`, 'Pass the path of a file, not a folder.');
  }
  if (rule.kind === 'either' && !stat.isFile() && !stat.isDirectory()) {
    throw new ToolError('NOT_A_FILE', `${shown(input)} is neither a file nor a folder.`, 'Pass the path of a folder or a file.');
  }
  if (stat.isFile() && rule.extensions) {
    // Both names must pass: the one given, and the real one a link leads to.
    checkExtension(root, input, lexRel, rule);
    checkExtension(root, input, realRel, rule);
  }
  if (stat.isFile() && rule.maxBytes !== undefined && stat.size > rule.maxBytes) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `${shown(input)} is ${formatSize(stat.size)}; this tool reads at most ${formatMib(rule.maxBytes)}.`,
      'Export a smaller file (a date range, say) and check the parts one by one.',
    );
  }
  return { real, rel: toPosix(lexRel), size: stat.size, isDirectory: stat.isDirectory() };
}

/**
 * The tool error for a file or folder that passed the checks but could not be read: another program has
 * it locked (Windows), the permissions forbid it, or it went away in between. `shownPath` is the path
 * relative to the root; it is made safe here.
 */
export function unreadable(shownPath: string, err: unknown): ToolError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const [why, fix] =
    code === 'EBUSY'
      ? ['is locked by another program', 'Close the program that holds it, then call again.']
      : code === 'EACCES' || code === 'EPERM'
        ? ['cannot be read (permission denied)', 'Give the user that runs the server read access to it, and read and search (x) access to each folder on its path, then call again.']
        : code === 'ENOENT'
          ? ['no longer exists', 'It was moved or deleted while the tool read it: check the path, then call again.']
          : [`cannot be read (${typeof code === 'string' ? clip(code, 20) : 'an unknown error'})`, 'Close the program that holds it, or fix its permissions, then call again.'];
  return new ToolError('FILE_UNREADABLE', `${quotedPath(shownPath)} ${why}.`, fix);
}

/** Whether a file-system error means the path is there but may not be read now: permissions, a lock. */
export function deniedOrLocked(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
}

/** Read a file that resolveInRoot accepted; a read that fails is FILE_UNREADABLE, not a crash. */
export function readChecked(real: string, shownPath: string): Buffer {
  try {
    return readFileSync(real);
  } catch (err) {
    throw unreadable(shownPath, err);
  }
}

export function formatMib(bytes: number): string {
  return `${(bytes / MIB).toFixed(bytes < 10 * MIB ? 1 : 0)} MiB`;
}

/** A size over a limit, exact enough to see that it is over: "25 MiB (26,214,401 bytes)". */
export function formatSize(bytes: number): string {
  return `${formatMib(bytes)} (${bytes.toLocaleString('en-GB')} bytes)`;
}
