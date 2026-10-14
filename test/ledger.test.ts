import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { checkLedgerFile, type LedgerParams } from '../src/ledger/run.js';
import type { Root } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

let root: Root;
let n = 0;

beforeAll(() => {
  root = rootOf(tempDir());
});

/** SPEC.md §4.5's Finding table, in order. */
const FINDING_FIELDS = ['code', 'severity', 'transaction_id', 'lines', 'pointers', 'more_rows', 'field', 'value', 'nets', 'message'];

/** Write `content` to a new file with extension `ext` in the project and check it. Every result of
 *  every test here must keep the output rules: the documented field order (the model reads the
 *  findings as text), messages of at most 120 characters, nothing from the file longer than 40, and
 *  at most 20,000 characters in all (SPEC.md §2.4, §4.5). */
function check(ext: string, content: string | Uint8Array, params: Omit<LedgerParams, 'file'>) {
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

function codeOf(fn: () => unknown): ErrorCode | 'no error' {
  try {
    fn();
    return 'no error';
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
}

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err.toText();
  }
  throw new Error('expected a ToolError');
}

const SIGNED = { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'currency' };

const SPEC_EXAMPLE = `txn_id,account,amount_pence,currency
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

describe('money_check_double_entry: the SPEC.md §4.9 example', () => {
  it('gives exactly the documented result, field for field and in the documented order', () => {
    const r = check('.csv', SPEC_EXAMPLE, { columns: SIGNED });
    const expected = {
      summary: 'Not balanced: 3 errors and 1 warning. 4 transactions: 2 balanced, 1 unbalanced, 1 not checked (rows with unreadable values).',
      file: r.file,
      format: 'csv',
      file_sha256: createHash('sha256').update(SPEC_EXAMPLE).digest('hex'),
      rows_read: 9,
      transactions_found: 4,
      transactions_checked: 3,
      transactions_balanced: 2,
      transactions_not_checked: 1,
      balanced: false,
      error_count: 3,
      warning_count: 1,
      counts_by_code: { UNBALANCED: 1, FRACTIONAL_MINOR_UNITS: 2, ZERO_LEG: 1 },
      findings: [
        { code: 'UNBALANCED', severity: 'error', transaction_id: 'T2', lines: [4, 5], nets: [{ currency: 'GBP', net: '-1' }], message: 'GBP legs net to -1, not 0' },
        { code: 'FRACTIONAL_MINOR_UNITS', severity: 'error', transaction_id: 'T3', lines: [6], field: 'amount', value: '10.5', message: '10.5 is not a whole number of minor units' },
        { code: 'FRACTIONAL_MINOR_UNITS', severity: 'error', transaction_id: 'T3', lines: [7], field: 'amount', value: '-10.5', message: '-10.5 is not a whole number of minor units' },
        { code: 'ZERO_LEG', severity: 'warning', transaction_id: 'T4', lines: [8], field: 'amount', value: '0', message: 'a leg of 0 moves nothing' },
      ],
      offset: 0,
      limit: 20,
      total_findings: 4,
      next_offset: null,
    };
    expect(r).toEqual(expected);
    expect(JSON.stringify(r)).toBe(JSON.stringify(expected));
    expect(r.file).toMatch(/^exports\/ledger-\d+\.csv$/);
  });

  it('gives byte-identical results for the same file (deterministic)', () => {
    const a = check('.csv', SPEC_EXAMPLE, { columns: SIGNED });
    const b = check('.csv', SPEC_EXAMPLE, { columns: SIGNED });
    expect(JSON.stringify({ ...a, file: '' })).toBe(JSON.stringify({ ...b, file: '' }));
  });
});

describe('money_check_double_entry: the rules', () => {
  it('passes a balanced file, and says so', () => {
    const r = check('.csv', 'txn_id,amount_pence,currency\nA,500,GBP\nA,-500,GBP\nB,1,GBP\nB,-1,GBP\n', { columns: SIGNED });
    expect(r.balanced).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.summary).toBe('Balanced: all 2 transactions net to zero in whole minor units.');
  });

  it('proves nothing on an empty file', () => {
    for (const content of ['', 'txn_id,amount_pence,currency\n']) {
      const r = check('.csv', content, { columns: SIGNED });
      expect(r.rows_read).toBe(0);
      expect(r.balanced).toBe(false);
      expect(r.summary).toBe('The file has no rows, so nothing was proven.');
    }
  });

  it('balances each currency on its own, and lists every currency that is off', () => {
    const ok = check('.csv', 'txn_id,amount_pence,currency\nFX,100,GBP\nFX,-100,gbp\nFX,700,EUR\nFX,-700,EUR\n', { columns: SIGNED });
    expect(ok.balanced).toBe(true);
    const off = check('.csv', 'txn_id,amount_pence,currency\nFX,100,GBP\nFX,-50,GBP\nFX,700,USD\nFX,-650,EUR\n', { columns: SIGNED });
    expect(off.findings).toEqual([
      {
        code: 'UNBALANCED',
        severity: 'error',
        transaction_id: 'FX',
        lines: [2, 3, 4, 5],
        nets: [
          { currency: 'EUR', net: '-650' },
          { currency: 'GBP', net: '50' },
          { currency: 'USD', net: '700' },
        ],
        message: 'EUR legs net to -650 and GBP legs net to 50 and USD legs net to 700, not 0',
      },
    ]);
  });

  it('reports a transaction with fewer than two moving legs as TOO_FEW_LEGS only', () => {
    const r = check('.csv', 'txn_id,amount_pence\nA,500\nB,0\nB,0\n', { columns: { transaction_id: 'txn_id', amount: 'amount_pence' } });
    expect(r.findings.map((f) => [f.code, f.transaction_id, f.lines])).toEqual([
      ['TOO_FEW_LEGS', 'A', [2]],
      ['TOO_FEW_LEGS', 'B', [3, 4]],
      ['ZERO_LEG', 'B', [3]],
      ['ZERO_LEG', 'B', [4]],
    ]);
    expect(r.findings[0]?.message).toBe('only 1 non-zero leg; a transaction needs at least two');
    expect(r.findings[1]?.message).toBe('no non-zero leg; a transaction needs at least two');
  });

  it('sums with exact integers, past what a double can hold', () => {
    const big = '9007199254740991';
    const r = check('.csv', `t,a\nX,${big}\nX,${big}\nX,-${big}\nX,-${big}\nY,${big}\nY,${big}\nY,-${big}\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings).toEqual([expect.objectContaining({ code: 'UNBALANCED', transaction_id: 'Y', nets: [{ currency: null, net: big }], message: `legs net to ${big}, not 0` })]);
  });

  it('reports a row without a transaction id on its own', () => {
    const r = check('.csv', 't,a\n,100\nA,1\nA,-1\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings).toEqual([{ code: 'MISSING_VALUE', severity: 'error', transaction_id: null, lines: [2], field: 'transaction_id', message: 'no transaction_id' }]);
    expect(r.transactions_found).toBe(1);
  });

  it('reads an amount plus a debit/credit side', () => {
    const columns = { transaction_id: 't', amount: 'a', side: 's' };
    expect(check('.csv', 't,a,s\nA,100,D\nA,100,cr\nB,5,DEBIT\nB,5,Credit\n', { columns }).balanced).toBe(true);
    const r = check('.csv', 't,a,s\nA,100,X\nA,100,C\nB,-5,D\nB,5,C\nC,7,\nC,7,C\n', { columns });
    expect(r.findings.map((f) => [f.code, f.transaction_id, f.field, f.value])).toEqual([
      ['BAD_SIDE', 'A', 'side', 'X'],
      ['NEGATIVE_WITH_SIDE', 'B', 'amount', '-5'],
      ['MISSING_VALUE', 'C', 'side', undefined],
    ]);
    expect(r.transactions_not_checked).toBe(3);
  });

  it('reads separate debit and credit columns in decimal format (an accounting export)', () => {
    const columns = { transaction_id: 'Journal', debit: 'Debit', credit: 'Credit', currency: 'Currency' };
    const csv = 'Journal,Account,Debit,Credit,Currency\nJ1,Bank,120.00,,GBP\nJ1,Sales,,100.00,GBP\nJ1,VAT,,20.00,GBP\nJ2,Bank,,,GBP\nJ2,Fees,0.50,,GBP\n';
    const r = check('.csv', csv, { columns, amount_format: 'decimal' });
    expect(r.findings.map((f) => [f.code, f.transaction_id, f.field])).toEqual([['MISSING_VALUE', 'J2', 'debit/credit']]);
    expect(r.transactions_balanced).toBe(1);
  });

  it('reports a decimal amount with too many places', () => {
    const r = check('.csv', 't,a\nA,10.001\nA,-10.001\n', { columns: { transaction_id: 't', amount: 'a' }, amount_format: 'decimal' });
    expect(r.findings[0]).toMatchObject({ code: 'FRACTIONAL_MINOR_UNITS', value: '10.001', message: '10.001 has more than 2 decimal places' });
    expect(check('.csv', 't,a\nA,1500\nA,-1500\n', { columns: { transaction_id: 't', amount: 'a' }, amount_format: 'decimal', decimal_places: 0 }).balanced).toBe(true);
  });

  it('caps a finding at 20 row locations and counts the rest', () => {
    const rows = Array.from({ length: 25 }, () => 'BIG,1').join('\n');
    const r = check('.csv', `t,a\n${rows}\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', more_rows: 5 });
    expect(r.findings[0]?.lines).toHaveLength(20);
  });

  it('cuts a long value to 40 characters', () => {
    const r = check('.csv', `t,a\nA,${'9x'.repeat(50)}\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect([...(r.findings[0]?.value ?? '')]).toHaveLength(40);
  });

  it('cuts a long currency to 40 characters for display, but groups by the whole text', () => {
    const long = 'X'.repeat(60);
    const r = check('.csv', `t,a,c\nA,5,${long}1\nA,-5,${long}2\n`, { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    const shown = `${'X'.repeat(39)}…`;
    expect(r.findings[0]?.nets).toEqual([
      { currency: shown, net: '5' },
      { currency: shown, net: '-5' },
    ]);
    expect(r.findings[0]?.message).toBe(`${shown} legs net to 5 and ${shown} legs net to -5, not…`);
  });

  it('lists at most 20 currencies that are off, and says how many there are', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `A,1,C${String(i).padStart(2, '0')}`).join('\n');
    const r = check('.csv', `t,a,c\n${rows}\n`, { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    expect(r.findings[0]?.nets).toHaveLength(20);
    expect(r.findings[0]?.nets?.[19]).toEqual({ currency: 'C19', net: '1' });
    expect(r.findings[0]?.message).toBe('25 currencies do not net to 0; nets lists the first 20');
  });

  it('returns a shorter page when long locations would pass 20,000 characters, and pages on to the end', () => {
    // 30 unbalanced transactions of 20 legs each, under a 251-character records pointer: a full page of
    // 20 findings, each with 20 pointers, would be about 100,000 characters.
    const records = Array.from({ length: 600 }, (_, i) => ({ t: `T${Math.floor(i / 20)}`, a: 1 }));
    const content = JSON.stringify({ ['r'.repeat(250)]: records });
    const seen: Array<string | null> = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const r = check('.json', content, { columns: { transaction_id: 't', amount: 'a' }, records_pointer: `/${'r'.repeat(250)}`, offset });
      expect(r.findings.length).toBeGreaterThan(0);
      expect(r.findings.length).toBeLessThan(20);
      expect(r.limit).toBe(20);
      seen.push(...r.findings.map((f) => f.transaction_id));
      offset = r.next_offset;
    }
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => `T${i}`));
  });
});

describe('money_check_double_entry: reading CSV', () => {
  const columns = { transaction_id: 't', amount: 'a' };

  it('gives the line a record starts on, with quoted line breaks, CRLF, a BOM and blank lines', () => {
    const csv = '﻿t,note,a\r\nA,"two\r\nlines",100\r\n\r\nA,x,-99\r\n';
    const r = check('.csv', csv, { columns });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', lines: [2, 5] });
  });

  it('matches a header name exactly, else by letter case alone', () => {
    expect(check('.csv', 'T,A\nX,1\nX,-1\n', { columns }).balanced).toBe(true);
  });

  it('names the columns it has, and the closest one, when a mapped column is missing', () => {
    const text = errorText(() => check('.csv', 'txn_id,amount_pence\nA,1\n', { columns: { transaction_id: 'txn_id', amount: 'amount_pens' } }));
    expect(text).toBe(
      'COLUMN_NOT_FOUND: The CSV header has no column "amount_pens" (mapped as amount). Did you mean "amount_pence"? The columns are: "txn_id", "amount_pence". Fix: Map each field to one of the column names in the header.',
    );
  });

  it('groups a quoted id with spaces around it with the same id, and reads a quoted blank id as missing', () => {
    const r = check('.csv', 't,a\n"T1 ",5\nT1,-5\n"   ",1\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.transactions_found).toBe(1);
    expect(r.findings.map((f) => [f.code, f.field])).toEqual([['MISSING_VALUE', 'transaction_id']]);
  });

  it('gives the right line numbers in a file with CR-only line ends (old Mac Excel)', () => {
    const r = check('.csv', 't,a\rA,1\r\rA,-2\r', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', lines: [2, 4] });
  });

  it('treats an id that reads "not text" as an ordinary id', () => {
    expect(check('.csv', 't,a\nnot text,5\nnot text,-5\n', { columns: { transaction_id: 't', amount: 'a' } }).balanced).toBe(true);
  });

  it('finds the closest column quickly even in a huge hostile header', () => {
    // 2,000 columns of 1,000 characters, and a 200-character mapped name: the distances were computed
    // over whole names, many times each during a sort (seconds); now once per column, over the first 64
    // characters.
    const header = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, '0')}${'c'.repeat(996)}`).join(',');
    const started = performance.now();
    expect(errorText(() => check('.csv', `${header}\n`, { columns: { transaction_id: 'x'.repeat(200), amount: 'a' } }))).toMatch(/^COLUMN_NOT_FOUND: /);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a mapped name that appears twice', () => {
    expect(codeOf(() => check('.csv', 't,a,a\nA,1,2\n', { columns }))).toBe('COLUMN_AMBIGUOUS');
  });

  it('reports broken CSV with the line the broken record starts on', () => {
    expect(errorText(() => check('.csv', 't,a\nA,1\nA,2,3\n', { columns }))).toMatch(/^PARSE_ERROR: Line 3: the row does not have as many fields as the header\./);
    expect(errorText(() => check('.csv', 't,a\nA,"1\n', { columns }))).toMatch(/^PARSE_ERROR: Line 2: a quoted field is never closed\./);
    // A quoted CRLF and a blank line before the bad row: csv-parse's own line count says 6 here.
    expect(errorText(() => check('.csv', 't,a\r\nA,"x\r\ny"\r\n\r\nB,1,2\r\n', { columns }))).toMatch(/^PARSE_ERROR: Line 5: /);
    expect(errorText(() => check('.csv', 't,a\nA,1\n\nB,"x\nC,1\n', { columns }))).toMatch(/^PARSE_ERROR: Line 4: a quoted field is never closed\./);
    expect(errorText(() => check('.csv', 't,a\nA,1\nB,"x"y\n', { columns }))).toMatch(/^PARSE_ERROR: Line 3: a quote closes in the middle of a field\./);
    expect(errorText(() => check('.csv', 't,a\nA,1\nB,x"y"\n', { columns }))).toMatch(/^PARSE_ERROR: Line 3: a quote opens in the middle of a field\./);
  });

  it('takes another delimiter, and tabs for .tsv', () => {
    expect(check('.csv', 't;a\nA;1\nA;-1\n', { columns, delimiter: ';' }).balanced).toBe(true);
    expect(check('.tsv', 't\ta\nA\t1\nA\t-1\n', { columns }).balanced).toBe(true);
  });

  it('refuses a file that is not UTF-8', () => {
    expect(errorText(() => check('.csv', Buffer.from([0x74, 0x2c, 0x61, 0x0a, 0xff, 0x2c, 0x31, 0x0a]), { columns }))).toMatch(/^PARSE_ERROR: The file is not valid UTF-8 text\./);
  });
});

describe('money_check_double_entry: reading JSON and JSONL', () => {
  it('finds the records by JSON Pointer, reads nested fields, and points at records', () => {
    const doc = { meta: {}, data: { entries: [{ id: 1, amount: { value: 100 } }, { id: 1, amount: { value: -90 } }, 'oops'] } };
    const r = check('.json', JSON.stringify(doc), { columns: { transaction_id: 'id', amount: '/amount/value' }, records_pointer: '/data/entries' });
    expect(r.findings).toEqual([
      expect.objectContaining({ code: 'UNBALANCED', transaction_id: '1', pointers: ['/data/entries/0', '/data/entries/1'], nets: [{ currency: null, net: '10' }] }),
      { code: 'BAD_ROW', severity: 'error', transaction_id: null, pointers: ['/data/entries/2'], message: 'the record is not a JSON object' },
    ]);
  });

  it('keeps JSON number ids and amounts exact, where a 64-bit float would merge ids and round fractions away', () => {
    const r = check(
      '.jsonl',
      '{"t":1234567890123456789,"a":-2500}\n{"t":1234567890123456790,"a":2500}\n{"t":"F","a":4503599627370496.5}\n{"t":"F","a":-4503599627370496}\n',
      { columns: { transaction_id: 't', amount: 'a' } },
    );
    expect(r.balanced).toBe(false);
    expect(r.findings.map((f) => [f.code, f.transaction_id, f.value ?? null])).toEqual([
      ['TOO_FEW_LEGS', '1234567890123456789', null],
      ['TOO_FEW_LEGS', '1234567890123456790', null],
      ['FRACTIONAL_MINOR_UNITS', 'F', '4503599627370496.5'],
    ]);
  });

  it('names the fields the records have when a mapped field is in no record', () => {
    expect(errorText(() => check('.json', '[{"id":"A","value":5},{"id":"A","value":-5}]', { columns: { transaction_id: 'id', amount: 'amount' } }))).toBe(
      'COLUMN_NOT_FOUND: No record has the field "amount" (mapped as amount). The first record\'s fields are: "id", "value". Fix: Map each field to a field the records have, or to a JSON Pointer such as "/amount/value" for a nested one.',
    );
    // A field that some records have is a problem of the others instead.
    expect(check('.jsonl', '{"id":"A","amount":5}\n{"id":"A"}\n', { columns: { transaction_id: 'id', amount: 'amount' } }).counts_by_code).toEqual({ MISSING_VALUE: 1 });
  });

  it('says what it found when the records are not an array', () => {
    expect(errorText(() => check('.json', '{"data":[],"meta":{}}', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(
      /^RECORDS_NOT_ARRAY: The top of the file is an object with keys data, meta, not an array of records\./,
    );
    expect(errorText(() => check('.json', '{"data":[]}', { columns: { transaction_id: 'id', amount: 'a' }, records_pointer: '/nope' }))).toMatch(/is nothing \(the pointer leads nowhere\)/);
  });

  it('reports invalid JSON with its line and column', () => {
    expect(errorText(() => check('.json', '[\n  {"id": 1,}\n]', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(/^PARSE_ERROR: Line 2, column \d+: the file is not valid JSON/);
  });

  it('reads JSONL line by line, skipping blank lines and reporting a bad line without stopping', () => {
    const jsonl = '{"t":"A","a":5}\n\n{"t":"A","a":-5}\nnot json\n[1]\n{"t":"B","a":1}\r\n{"t":"B","a":-1}\n';
    const r = check('.jsonl', jsonl, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.rows_read).toBe(6);
    expect(r.findings).toEqual([
      { code: 'BAD_ROW', severity: 'error', transaction_id: null, lines: [4], message: 'the line is not valid JSON' },
      { code: 'BAD_ROW', severity: 'error', transaction_id: null, lines: [5], message: 'the line is not a JSON object' },
    ]);
    expect(r.transactions_balanced).toBe(2);
  });

  it('never uses JSON.parse: a "__proto__" field is an ordinary field', () => {
    const r = check('.jsonl', '{"__proto__":"A","a":1}\n{"__proto__":"A","a":-1}\n', { columns: { transaction_id: '__proto__', amount: 'a' } });
    expect(r.balanced).toBe(true);
  });

  it('refuses more than 1,000,000 rows', () => {
    expect(codeOf(() => check('.jsonl', '{}\n'.repeat(1_000_001), { columns: { transaction_id: 't', amount: 'a' } }))).toBe('TOO_MANY_ROWS');
  });
});

describe('money_check_double_entry: arguments', () => {
  it('refuses a column shape that is not one of the three', () => {
    for (const columns of [
      { transaction_id: 't' },
      { transaction_id: 't', amount: 'a', debit: 'd', credit: 'c' },
      { transaction_id: 't', debit: 'd' },
      { transaction_id: 't', side: 's', debit: 'd', credit: 'c' },
    ]) {
      expect(codeOf(() => check('.csv', 't,a\n', { columns })), JSON.stringify(columns)).toBe('MAPPING_INVALID');
    }
  });

  it('pages through the findings with offset and limit', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `T${i},1`).join('\n');
    const columns = { transaction_id: 't', amount: 'a' };
    const first = check('.csv', `t,a\n${rows}\n`, { columns, limit: 10 });
    expect([first.findings.length, first.total_findings, first.next_offset]).toEqual([10, 30, 10]);
    const last = check('.csv', `t,a\n${rows}\n`, { columns, offset: 20, limit: 10 });
    expect([last.findings[0]?.transaction_id, last.next_offset]).toEqual(['T20', null]);
    expect(check('.csv', `t,a\n${rows}\n`, { columns, limit: 500 }).limit).toBe(50);
    expect(first.counts_by_code).toEqual({ TOO_FEW_LEGS: 30 });
  });
});
