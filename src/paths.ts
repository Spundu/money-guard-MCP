// Which files the tools may read (SPEC.md §2.3). Every path argument goes through resolveInRoot; the
// migration-folder walk (lint/files.ts) uses the same checks for every file it finds.
//
// The order of the checks matters: a path that is outside the project is refused BEFORE the file system
// is touched, so the answer never reveals whether something outside the project exists.

import { readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clip, clipPath } from './echo.js';
import { ToolError } from './errors.js';

/** The project folder, already resolved to its real path (config.ts). */
export interface Root {
  /** Absolute real path. Never shown in a result or an error. */
  real: string;
  /** Its folder name, the only part of it that messages show, as they show it (through `clip`). */
  name: string;
}

export interface PathRule {
  /** 'either': a folder, or a file with an allowed extension (a migrations folder or one schema file). */
  kind: 'file' | 'directory' | 'either';
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

/** Whether `candidate` (absolute) is `root` or inside it. Works across drives and letter case on Windows. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/**
 * Names the tools refuse at any depth: environment files, private keys and certificates, package-manager
 * and git credentials, cloud credential downloads (.csv and .json files: AWS access-key CSVs, Google
 * client secrets and service-account keys, credentials and secrets files), and anything inside .git
 * (SPEC.md §2.3). Compared in lower case. The credential words only count in .csv and .json names: a
 * migration such as 0002_create_access_keys.sql, or a folder add_service_accounts, is not a secret.
 */
export function isSensitive(rel: string): boolean {
  const segments = rel.split(/[\\/]/).map((s) => s.toLowerCase());
  if (segments.includes('.git')) return true;
  const base = segments.at(-1) ?? '';
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    ['.npmrc', '.pypirc', '.netrc', '.git-credentials'].includes(base) ||
    base.startsWith('id_rsa') ||
    base.startsWith('id_ed25519') ||
    ['.pem', '.key', '.p12', '.pfx', '.keystore'].some((ext) => base.endsWith(ext)) ||
    (/\.(?:csv|json)$/.test(base) &&
      (/^(?:credentials|secrets)[._-]/.test(base) || /accesskeys|access_keys|rootkey|client_secret|service[-_]account/.test(base)))
  );
}

function shown(input: string): string {
  return `"${clipPath(input)}"`;
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
  if (isSensitive(rel)) {
    throw new ToolError(
      'SENSITIVE_PATH',
      `${shown(input)} looks like a secrets file (an .env file, a private key or credentials).`,
      'money-guard never reads secret files. Point it at migrations, ledger exports or audit logs.',
    );
  }
}

function checkExtension(root: Root, input: string, rel: string, extensions: readonly string[]): void {
  if (!extensions.includes(path.extname(rel).toLowerCase())) {
    throw new ToolError(
      'FILE_TYPE_NOT_ALLOWED',
      `${shown(input)} is not one of the file types this tool reads.`,
      `Pass a file ending in ${extensions.join(', ')} inside the project folder (${root.name}).`,
    );
  }
}

/** The closest folder above `lexical` that exists, relative to the root ("." for the root). */
function nearestExisting(root: Root, lexical: string): string {
  let dir = path.dirname(lexical);
  while (isInside(root.real, dir)) {
    try {
      if (statSync(dir).isDirectory()) return toPosix(path.relative(root.real, dir));
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '.';
}

/**
 * Resolve a path argument and check it against every rule of SPEC.md §2.3. Throws a ToolError naming the
 * first rule it breaks; returns the real path to read and the relative path to show.
 */
export function resolveInRoot(root: Root, input: string, rule: PathRule): ResolvedPath {
  checkSyntax(input);

  const lexical = path.resolve(root.real, input);
  if (!isInside(root.real, lexical)) {
    throw new ToolError(
      'PATH_OUTSIDE_ROOT',
      `${shown(input)} is outside the project folder (${root.name}).`,
      'Pass a path inside the project, relative to its root.',
    );
  }
  const lexRel = path.relative(root.real, lexical);
  checkSensitive(input, lexRel);
  // A file rule refuses the wrong type before touching the disk; 'either' must first learn what it is.
  if (rule.kind === 'file' && rule.extensions) checkExtension(root, input, lexRel, rule.extensions);

  let real: string;
  try {
    real = realpathSync.native(lexical);
  } catch (err) {
    // The path is inside the project (checked above), so saying it cannot be read reveals nothing outside.
    if (deniedOrLocked(err)) throw unreadable(toPosix(lexRel), err);
    throw new ToolError(
      'PATH_NOT_FOUND',
      `${shown(input)} does not exist. The nearest existing folder is "${clipPath(nearestExisting(root, lexical))}".`,
      `Check the spelling. Paths are relative to the project folder (${root.name}).`,
    );
  }
  // A link inside the project may point outside it: the REAL target is what gets read.
  if (!isInside(root.real, real)) {
    throw new ToolError(
      'PATH_OUTSIDE_ROOT',
      `${shown(input)} is a link to a place outside the project folder (${root.name}).`,
      'Pass a file or folder that really lives inside the project.',
    );
  }
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
  if (rule.kind === 'directory' && !stat.isDirectory()) {
    throw new ToolError('NOT_A_DIRECTORY', `${shown(input)} is not a folder.`, 'Pass the path of a folder.');
  }
  if (rule.kind === 'either' && !stat.isFile() && !stat.isDirectory()) {
    throw new ToolError('NOT_A_FILE', `${shown(input)} is neither a file nor a folder.`, 'Pass the path of a folder or a file.');
  }
  if (stat.isFile() && rule.kind !== 'directory' && rule.extensions) {
    // Both names must pass: the one given, and the real one a link leads to.
    checkExtension(root, input, lexRel, rule.extensions);
    checkExtension(root, input, realRel, rule.extensions);
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
  const why =
    code === 'EBUSY'
      ? 'is locked by another program'
      : code === 'EACCES' || code === 'EPERM'
        ? 'cannot be read (permission denied)'
        : code === 'ENOENT'
          ? 'no longer exists'
          : `cannot be read (${typeof code === 'string' ? clip(code, 20) : 'an unknown error'})`;
  return new ToolError('FILE_UNREADABLE', `"${clipPath(shownPath)}" ${why}.`, 'Close the program that holds it, or fix its permissions, then call again.');
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
