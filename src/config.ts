// The server's settings (SPEC.md §2.2), resolved once at startup. A bad setting never stops the
// server: it is kept as a ToolError, and every tool that needs it answers with that error, so the model
// sees what is wrong and the other tools keep working.

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { InMemoryKeyProvider, MIN_KEY_BYTES, type KeyProvider } from 'sealed-audit-chain';
import { clip, hasUnsafe, quoted } from './echo.js';
import { ToolError } from './errors.js';
import type { Root } from './paths.js';

export type Setting<T> = { ok: true; value: T } | { ok: false; error: ToolError };

export interface AuditKeys {
  provider: KeyProvider;
  /** Configured key ids, in the order given. Never the key bytes. */
  ids: string[];
}

export interface Config {
  root: Setting<Root>;
  auditKeys: Setting<AuditKeys>;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A `${...}` value the MCP host did not fill in: Claude Code leaves `${VAR}` as it is when VAR is not
 * set, and Claude Desktop leaves `${user_config.x}` when an optional setting has no value. Such a value
 * means "not set", never a key ring or a folder name.
 */
const PLACEHOLDER = /^\$\{[^}]*\}$/;

/** The variable a placeholder names, as in `${NAME}`, `${NAME:-default}` or `${user_config.name}`. */
const PLACEHOLDER_NAME = /^\$\{([A-Za-z_][A-Za-z0-9_.]{0,63})(?::-[^}]*)?\}$/;

export function resolveConfig(env: Env, cwd: string): Config {
  return { root: resolveRoot(env, cwd), auditKeys: parseAuditKeys(env.MONEY_GUARD_AUDIT_KEYS) };
}

function resolveRoot(env: Env, cwd: string): Setting<Root> {
  const [source, value] = env.MONEY_GUARD_ROOT?.trim()
    ? ['MONEY_GUARD_ROOT', env.MONEY_GUARD_ROOT.trim()]
    : env.CLAUDE_PROJECT_DIR?.trim()
      ? ['CLAUDE_PROJECT_DIR', env.CLAUDE_PROJECT_DIR.trim()]
      : ['the working directory', cwd];
  const fix = 'Set MONEY_GUARD_ROOT in the server\'s environment to the project folder the tools may read (in Claude Desktop, choose the project folder in the extension\'s settings).';
  const invalid = (why: string) => ({ ok: false as const, error: new ToolError('ROOT_INVALID', `The project root (from ${source}) ${why}.`, fix) });
  // Fail closed: a broken setting must not quietly widen or move what the tools can read.
  if (PLACEHOLDER.test(value)) return invalid(`is ${quoted(value, 80)}, a placeholder the MCP host did not fill in`);
  // "C:" or "C:folder" means the current folder of drive C on Windows, wherever that is (review round 10).
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return invalid(`is ${quoted(value, 80)}, a drive letter without a backslash after it, which means whatever folder is current on that drive`);

  let real: string;
  try {
    real = realpathSync.native(path.resolve(cwd, value));
    if (!statSync(real).isDirectory()) return invalid('is not a folder');
    accessSync(real, constants.R_OK | constants.X_OK); // a folder that cannot be listed or entered
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return invalid(code === 'EACCES' || code === 'EPERM' ? 'cannot be opened (permission denied)' : 'does not exist');
  }
  // A whole disk would put every file on it in reach of the tools.
  if (path.parse(real).root === real) return invalid('is the root of a disk');
  return { ok: true, value: { real, name: clip(path.basename(real), 80) } };
}

const HEX = /^[0-9a-fA-F]+$/;

/** The most key pairs MONEY_GUARD_AUDIT_KEYS may hold (SPEC.md §2.2). */
export const MAX_KEYS = 64;

/**
 * MONEY_GUARD_AUDIT_KEYS: comma-separated `id=hex` pairs, at most MAX_KEYS. Ids are 1-64 characters
 * with no "=", "," or whitespace, and unique; keys are hex, at least MIN_KEY_BYTES bytes. Errors name
 * the pair by its position, never by any of its text.
 */
export function parseAuditKeys(raw: string | undefined): Setting<AuditKeys> {
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      error: new ToolError(
        'KEYS_NOT_CONFIGURED',
        'No HMAC keys are configured, so audit logs cannot be verified.',
        'Set MONEY_GUARD_AUDIT_KEYS in the server\'s environment as id=hex pairs separated by commas ' +
          '(for Claude Code, in .mcp.json as "${MONEY_GUARD_AUDIT_KEYS:-}", read from your shell; in Claude Desktop, in the extension\'s settings). Never paste a key into the chat.',
      ),
    };
  }
  if (PLACEHOLDER.test(raw.trim())) {
    // Name the variable, never the rest: a default after ":-" could be a key.
    const variable = PLACEHOLDER_NAME.exec(raw.trim())?.[1];
    const which = variable === undefined ? 'a ${...} placeholder' : `the placeholder for ${variable}`;
    return {
      ok: false,
      error: new ToolError(
        'KEYS_NOT_CONFIGURED',
        `MONEY_GUARD_AUDIT_KEYS holds ${which}, which the MCP host did not fill in: the variable or setting it names has no value.`,
        'Set that variable in the environment that starts your MCP client, or fill in the setting, then restart the client. Never paste a key into the chat.',
      ),
    };
  }
  const fix = 'Write MONEY_GUARD_AUDIT_KEYS as id=hex pairs separated by commas, e.g. k1=<64 hex digits>,k2=<64 hex digits>.';
  const invalid = (what: string) => ({ ok: false as const, error: new ToolError('KEYS_INVALID', `MONEY_GUARD_AUDIT_KEYS is malformed: ${what}.`, fix) });

  // No prototype: an id such as "__proto__" must be an ordinary key, never a prototype assignment.
  const keys: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const ids: string[] = [];
  const parts = raw.split(',');
  // Every result lists the ids; a bounded key ring keeps that list within the result budget.
  if (parts.length > MAX_KEYS) return invalid(`it has ${parts.length} pairs; at most ${MAX_KEYS} are allowed`);
  for (const [index, part] of parts.entries()) {
    const n = index + 1;
    const pair = part.trim();
    if (pair === '') return invalid(`pair ${n} is empty`);
    const eq = pair.indexOf('=');
    if (eq === -1) return invalid(`pair ${n} has no "="`);
    const id = pair.slice(0, eq).trim();
    const hex = pair.slice(eq + 1).trim();
    if (id.length === 0 || id.length > 64 || /\s/.test(id)) {
      return invalid(`pair ${n} has an id that is empty, longer than 64 characters or contains spaces`);
    }
    if (hasUnsafe(id)) return invalid(`pair ${n} has an id with a control or invisible character`);
    // Every audit result lists the ids: a key written where the id belongs would be shown to the model.
    if (/^[0-9a-fA-F]{32,}$/.test(id)) {
      return invalid(`pair ${n} has an id that looks like a key (32 or more hex digits); the id is a short name, and the key comes after "="`);
    }
    // Errors name pairs by position only: if the setting is malformed, the text before "=" may be key
    // material (a key written where the id belongs), so no part of a pair is ever repeated.
    if (Object.hasOwn(keys, id)) return invalid(`pair ${n} repeats the id of pair ${ids.indexOf(id) + 1}`);
    if (!HEX.test(hex) || hex.length % 2 !== 0) return invalid(`pair ${n} has a key that is not an even number of hex digits`);
    if (hex.length < MIN_KEY_BYTES * 2) return invalid(`pair ${n} has a key shorter than ${MIN_KEY_BYTES} bytes (${MIN_KEY_BYTES * 2} hex digits)`);
    keys[id] = Buffer.from(hex, 'hex');
    ids.push(id);
  }
  const first = ids[0];
  if (first === undefined) return invalid('no pairs');
  return { ok: true, value: { provider: new InMemoryKeyProvider(keys, first), ids } };
}
