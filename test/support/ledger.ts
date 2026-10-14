// Shared by the money_check_double_entry test files: one project folder per test file, and check(),
// which writes a file into it, checks it, and holds every result to the output rules.
import { beforeAll, expect } from 'vitest';
import { ToolError, type ErrorCode } from '../../src/errors.js';
import { checkLedgerFile, type LedgerParams } from '../../src/ledger/run.js';
import type { Root } from '../../src/paths.js';
import { rootOf, tempDir, writeTree } from './tmp.js';

let root: Root;
let n = 0;

beforeAll(() => {
  root = rootOf(tempDir());
});

/** SPEC.md §4.5's Finding table, in order. */
const FINDING_FIELDS = ['code', 'severity', 'transaction_id', 'lines', 'pointers', 'more_rows', 'field', 'value', 'nets', 'message'];

/** Write `content` to a new file with extension `ext` in the project and check it. Every result of
 *  every test must keep the output rules: the documented field order (the model reads the findings as
 *  text), messages of at most 120 characters, nothing from the file longer than 40, and at most 20,000
 *  characters in all (SPEC.md §2.4, §4.5). */
export function check(ext: string, content: string | Uint8Array, params: Omit<LedgerParams, 'file'>) {
  const file = `exports/ledger-${(n += 1)}${ext}`;
  writeTree(root.real, { [file]: content });
  const result = checkLedgerFile(root, { file, ...params });
  for (const finding of result.findings) {
    const keys = Object.keys(finding);
    expect(keys).toEqual(FINDING_FIELDS.filter((k) => keys.includes(k)));
    expect([...finding.message].length).toBeLessThanOrEqual(120);
    for (const text of [finding.transaction_id, finding.value, ...(finding.nets ?? []).map((net) => net.currency)]) {
      if (text !== null && text !== undefined) expect([...text].length).toBeLessThanOrEqual(40);
    }
  }
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
  return result;
}

export function codeOf(fn: () => unknown): ErrorCode | 'no error' {
  try {
    fn();
    return 'no error';
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
}

export function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.toText();
  }
  throw new Error('expected a ToolError');
}

export const SIGNED = { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'currency' };

/** The export of SPEC.md §4.9 (and of fixtures/shop/exports/journal.csv). */
export const SPEC_EXAMPLE = `txn_id,account,amount_pence,currency
T1,cash,1000,GBP
T1,sales,-1000,GBP
T2,cash,1999,GBP
T2,sales,-2000,GBP
T3,fees,10.5,GBP
T3,cash,-10.5,GBP
T4,cash,0,GBP
T4,sales,500,GBP
T4,vat,-500,GBP
`;
