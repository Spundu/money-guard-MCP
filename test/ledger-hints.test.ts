// money_check_double_entry (SPEC.md §4.3, §4.6): rows a spreadsheet adds below the data, and the currency
// hint never naming a column the mapping already reads (review round 25).
import { describe, expect, it } from 'vitest';
import { check } from './support/ledger.js';

describe('rows of empty cells', () => {
  it('skips a row of empty cells as a blank line, and keeps the lines of the rows after it', () => {
    const r = check('.csv', 'id,amount\nT1,100\nT1,-100\n,\n , \n', { columns: { transaction_id: 'id', amount: 'amount' } });
    expect([r.balanced, r.rows_read, r.findings]).toEqual([true, 2, []]);
    const after = check('.csv', 'id,amount\nT1,100\n,\nT1,-99\n', { columns: { transaction_id: 'id', amount: 'amount' } });
    expect(after.findings[0]).toMatchObject({ code: 'UNBALANCED', lines: [2, 4] });
  });
});

describe('the currency hint', () => {
  it('never names a mapped column, nor one whose words hold amt', () => {
    const amount = check('.csv', 'Txn Ref,Ccy Amt\nT1,100\nT1,-100\n', { columns: { transaction_id: 'Txn Ref', amount: 'Ccy Amt' } });
    expect(amount.summary).toBe('Balanced: the 1 transaction nets to zero in whole minor units.');
    const beside = check('.csv', 'id,local_amt,curr_amt\nT1,100,5\nT1,-100,5\n', { columns: { transaction_id: 'id', amount: 'local_amt' } });
    expect(beside.summary).not.toContain('looks like a currency');
    // A mapped column that is a currency word alone: the transaction id here.
    const id = check('.csv', 'ccy,amount\nT1,100\nT1,-100\n', { columns: { transaction_id: 'ccy', amount: 'amount' } });
    expect(id.summary).not.toContain('looks like a currency');
  });

  it('knows the French Monnaie, the Polish Waluta and the Portuguese Moeda', () => {
    for (const header of ['Monnaie', 'Waluta', 'Moeda']) {
      const r = check('.csv', `id,amount,${header}\nT1,100,PLN\nT1,-100,EUR\n`, { columns: { transaction_id: 'id', amount: 'amount' } });
      expect(r.summary, header).toContain(`"${header}" looks like a currency and is not mapped`);
    }
  });
});
