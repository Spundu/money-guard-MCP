// Shared by the money_lint_schema test files: one project folder per test file, and helpers that write
// files under a new sub-folder of it and lint them.
import path from 'node:path';
import { afterEach, beforeAll } from 'vitest';
import { ToolError, type ErrorCode } from '../../src/errors.js';
import { lintSchema, type LintParams } from '../../src/lint/run.js';
import type { Root } from '../../src/paths.js';
import { rootOf, tempDir, writeTree } from './tmp.js';

let root: Root;
let n = 0;
let ending = new AbortController();
let last: Promise<unknown> = Promise.resolve();

beforeAll(() => {
  root = rootOf(tempDir());
});

// A test that runs out of time leaves its lint running, and every later lint in the file would get
// BUSY: the lint is cancelled when its test ends, so only the slow test fails.
afterEach(async () => {
  ending.abort(new Error('the test has ended'));
  ending = new AbortController();
  await last.catch(() => {});
});

/** The project folder of this test file. */
export function projectRoot(): Root {
  return root;
}

/** A new sub-folder name of the project ("p7"). */
export function newDir(): string {
  return `p${(n += 1)}`;
}

/** The sub-folder the last lint() or newDir() used. */
export function lastDir(): string {
  return `p${n}`;
}

/**
 * lintSchema, cancelled when the test ends as every lint of a test must be: a lint called directly outside
 * this kept running past a test that ran out of time, and every later test of the file got BUSY (CI on a
 * 2-CPU runner, 2026-10-18: one slow test failed 20 more).
 */
export function lintTracked(at: Root, params: LintParams, signal?: AbortSignal): ReturnType<typeof lintSchema> {
  const result = lintSchema(at, params, signal === undefined ? ending.signal : AbortSignal.any([ending.signal, signal]));
  last = result;
  return result;
}

/** Write `files` under a fresh folder of the project and lint it. */
export async function lint(files: Record<string, string>, params: Partial<LintParams> = {}) {
  const dir = newDir();
  writeTree(path.join(root.real, dir), files);
  return lintTracked(root, { migrations: `${dir}/db/migrations`, ...params, ...(params.setup ? { setup: `${dir}/${params.setup}` } : {}) });
}

export async function failure(files: Record<string, string>, params: Partial<LintParams> = {}): Promise<ToolError> {
  try {
    await lint(files, params);
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('expected a ToolError');
}

export async function codeOf(files: Record<string, string>, params: Partial<LintParams> = {}): Promise<ErrorCode> {
  return (await failure(files, params)).code;
}

/** The project of SPEC.md §3.10 (and of fixtures/shop). */
export const SPEC_FILES = {
  'db/migrations/0001_init.sql': "create table orders (id bigserial primary key, total double precision not null, currency text not null default 'GBP');\n",
  'db/migrations/0002_fees.sql': 'alter table orders add column platform_fee numeric(10,2) not null default 0;\n',
  'db/migrations/0003_payouts.sql': 'create table payouts (id bigserial primary key, amount_pence bigint not null, fee_pence bigint not null);\n',
};
