// money_check_double_entry (SPEC.md §4): the documented example and the rules of a balanced ledger.
// test/ledger-read.test.ts covers reading CSV, JSON and JSONL files, and the arguments.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNED, SPEC_EXAMPLE, check } from './support/ledger.js';

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

  it('takes a zero amount with a side as a leg that moves nothing, not as a negative one', () => {
    const r = check('.csv', 't,a,s\nA,0,D\nA,5,D\nA,5,C\n', { columns: { transaction_id: 't', amount: 'a', side: 's' } });
    expect([r.balanced, r.findings.map((f) => f.code)]).toEqual([true, ['ZERO_LEG']]);
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
