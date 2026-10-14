// The server's settings (SPEC.md §2.2), resolved once at startup. A bad setting never stops the
// server: it is kept as a ToolError, and every tool that needs it answers with that error, so the model
// sees what is wrong and the other tools keep working.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { InMemoryKeyProvider, MIN_KEY_BYTES, type KeyProvider } from 'sealed-audit-chain';
import { clip } from './echo.js';
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

export function resolveConfig(env: Env, cwd: string): Config {
  return { root: resolveRoot(env, cwd), auditKeys: parseAuditKeys(env.MONEY_GUARD_AUDIT_KEYS) };
}

function resolveRoot(env: Env, cwd: string): Setting<Root> {
  const [source, value] = env.MONEY_GUARD_ROOT?.trim()
    ? ['MONEY_GUARD_ROOT', env.MONEY_GUARD_ROOT.trim()]
    : env.CLAUDE_PROJECT_DIR?.trim()
      ? ['CLAUDE_PROJECT_DIR', env.CLAUDE_PROJECT_DIR.trim()]
      : ['the working directory', cwd];
  const fix = 'Set MONEY_GUARD_ROOT in the server\'s environment to the project folder the tools may read.';
  const invalid = (why: string) => ({ ok: false as const, error: new ToolError('ROOT_INVALID', `The project root (from ${source}) ${why}.`, fix) });

  let real: string;
  try {
    real = realpathSync.native(path.resolve(cwd, value));
  } catch {
    return invalid('does not exist');
  }
  if (!statSync(real).isDirectory()) return invalid('is not a folder');
  // A whole disk would put every file on it in reach of the tools.
  if (path.parse(real).root === real) return invalid('is the root of a disk');
  return { ok: true, value: { real, name: path.basename(real) } };
}

const HEX = /^[0-9a-fA-F]+$/;

/** The most key pairs MONEY_GUARD_AUDIT_KEYS may hold (SPEC.md §2.2). */
export const MAX_KEYS = 64;

/**
 * MONEY_GUARD_AUDIT_KEYS: comma-separated `id=hex` pairs, at most MAX_KEYS. Ids are 1-64 characters
 * with no "=", "," or whitespace, and unique; keys are hex, at least MIN_KEY_BYTES bytes. Errors name
 * the pair, never a key value.
 */
export function parseAuditKeys(raw: string | undefined): Setting<AuditKeys> {
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      error: new ToolError(
        'KEYS_NOT_CONFIGURED',
        'No HMAC keys are configured, so audit logs cannot be verified.',
        'Set MONEY_GUARD_AUDIT_KEYS in the server\'s environment as id=hex pairs separated by commas ' +
          '(for Claude Code, in .mcp.json as "${MONEY_GUARD_AUDIT_KEYS:-}", read from your shell). Never paste a key into the chat.',
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
    const name = `pair ${n} ("${clip(id)}")`;
    if (Object.hasOwn(keys, id)) return invalid(`${name} repeats an id`);
    if (!HEX.test(hex) || hex.length % 2 !== 0) return invalid(`${name} has a key that is not an even number of hex digits`);
    if (hex.length < MIN_KEY_BYTES * 2) return invalid(`${name} has a key shorter than ${MIN_KEY_BYTES} bytes (${MIN_KEY_BYTES * 2} hex digits)`);
    keys[id] = Buffer.from(hex, 'hex');
    ids.push(id);
  }
  const first = ids[0];
  if (first === undefined) return invalid('no pairs');
  return { ok: true, value: { provider: new InMemoryKeyProvider(keys, first), ids } };
}
