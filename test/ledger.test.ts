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
        { code: 'UNBALANCED', severity: 'error', transaction_id: 'T2', lines: [4, 5], nets: [{ currency: 'GBP', net: '-1' }], message: '"GBP" legs net to -1, not 0' },
        { code: 'FRACTIONAL_MINOR_UNITS', severity: 'error', transaction_id: 'T3', lines: [6], field: 'amount', value: '10.5', message: '"10.5" is not a whole number of minor units' },
        { code: 'FRACTIONAL_MINOR_UNITS', severity: 'error', transaction_id: 'T3', lines: [7], field: 'amount', value: '-10.5', message: '"-10.5" is not a whole number of minor units' },
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
        message: '"EUR" legs net to -650 and "GBP" legs net to 50 and "USD" legs net to 700, not 0',
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
    // The summary explains the error, which the transaction counts alone would not.
    expect(r.summary).toBe('Not balanced: 1 error. 1 transaction: 1 balanced. 1 row is outside any transaction (no readable id, or not a record).');
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
    // Review round 17 (found by mutation): a JSON null side is missing too.
    const nul = check('.jsonl', '{"t":"A","a":1,"s":null}\n{"t":"A","a":1,"s":"C"}\n', { columns });
    expect(nul.findings.map((f) => [f.code, f.field])).toEqual([['MISSING_VALUE', 'side']]);
  });

  it('reads DR as a debit and CR as a credit', () => {
    expect(check('.csv', 't,a,s\nA,100,DR\nA,100,CR\n', { columns: { transaction_id: 't', amount: 'a', side: 's' } }).balanced).toBe(true);
  });

  it('nets debit minus credit: debits over credits by 20.00 is +2000, with the sign kept', () => {
    const r = check('.csv', 'j,d,c\nJ1,120.00,\nJ1,,100.00\n', { columns: { transaction_id: 'j', debit: 'd', credit: 'c' }, amount_format: 'decimal' });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', nets: [{ currency: null, net: '2000' }], message: 'legs net to 2000, not 0' });
  });

  it('reports an empty currency cell as MISSING_VALUE, not as a currency of its own', () => {
    const r = check('.csv', 't,a,c\nA,5,GBP\nA,-5,\n', { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    expect(r.findings.map((f) => [f.code, f.field, f.message])).toEqual([['MISSING_VALUE', 'currency', 'no currency']]);
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

  it('tells a file of pounds read as pence what to pass, instead of calling 12.00 a fraction', () => {
    // The most common export (12.00, 19.99) with the default amount_format.
    const r = check('.csv', 't,a\nA,12.00\nA,-12.00\nB,19.99\nB,-19.99\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings.map((f) => f.message)).toEqual([
      '"12.00" has a decimal point; minor units are whole numbers without one',
      '"-12.00" has a decimal point; minor units are whole numbers without one',
      '"19.99" is not a whole number of minor units',
      '"-19.99" is not a whole number of minor units',
    ]);
    expect(r.summary).toMatch(/ Half or more of the non-zero amounts have a decimal point: if the file holds pounds or dollars \(12\.34\), call again with amount_format "decimal"\.$/);
    // Half of the amounts with a decimal point, and a leg of 0, which says nothing: still worth the hint.
    const excel = check('.csv', 't,a\nA,12.5\nA,-12.5\nB,3\nB,-3\nB,0\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(excel.summary).toMatch(/ Half or more of the non-zero amounts have a decimal point/);
    // JSON as PostgreSQL's json_agg writes numeric(10,2): 12.00 is a whole number, but written in pounds.
    const json = check('.json', '[{"t":"A","a":12.00},{"t":"A","a":-12.00}]', { columns: { transaction_id: 't', amount: 'a' } });
    expect(json.summary).toMatch(/^Balanced: .* Half or more of the non-zero amounts have a decimal point/);
    // Zeros are left aside: a pence file in debit/credit form with 0.00 placeholders gets no hint.
    const placeholders = check('.csv', 't,d,c\nT1,1000,0.00\nT1,0.00,1000\n', { columns: { transaction_id: 't', debit: 'd', credit: 'c' } });
    expect(placeholders.summary).not.toMatch(/amount_format/);
    // A pence file with one bad transaction keeps the plain summary: most of its amounts are whole.
    const pence = check('.csv', 't,a\nA,1000\nA,-1000\nC,250\nC,-250\nB,10.5\nB,-10.5\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(pence.summary).not.toMatch(/amount_format/);
    // Amounts that amount_format "decimal" would refuse too (a currency sign, a thousands comma) do not
    // send the model there: only plain decimals such as 12.34 count.
    const signs = check('.csv', 't,a\nA,£12.00\nA,-£12.00\nB,"1,234.50"\nB,"-1,234.50"\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(signs.findings.map((f) => f.code)).toEqual(['BAD_AMOUNT', 'BAD_AMOUNT', 'BAD_AMOUNT', 'BAD_AMOUNT']);
    expect(signs.summary).not.toMatch(/amount_format/);
  });

  it('names a currency column that is not mapped, since every row then counts as one currency', () => {
    const r = check('.csv', 'txn_id,amount_pence,Currency\nT1,10000,GBP\nT1,-10000,EUR\n', { columns: { transaction_id: 'txn_id', amount: 'amount_pence' } });
    expect(r.summary).toBe('Balanced: the 1 transaction nets to zero in whole minor units. "Currency" looks like a currency and is not mapped: map it as currency to check each currency on its own (now every row counts as one).');
    // Payment processors' names for it, and a currency beside a nested amount (review round 4).
    const columns = { transaction_id: 't', amount: 'a' };
    for (const header of ['Gross Currency', 'Currency ISO Code', 'iso_currency_code', 'presentment_currency', 'currencyCode', 'ccy',
      // Review round 5: the word anywhere, in camelCase too.
      'currency_iso', 'CurrencyISO', 'Currency (ISO)', 'Currency Code (ISO 4217)', 'curr', 'currencies', 'baseCurrency', 'settlementCurrency', 'presentmentCurrencyCode', 'txnCcy']) {
      const csv = check('.csv', `t,a,${header}\nT1,10000,EUR\nT1,-10000,USD\n`, { columns });
      expect(csv.summary, header).toContain(` "${header}" looks like a currency and is not mapped`);
    }
    const nested = check('.jsonl', '{"t":"T1","amount":{"value":100,"currency":"EUR"}}\n{"t":"T1","amount":{"value":-100,"currency":"USD"}}\n', { columns: { transaction_id: 't', amount: '/amount/value' } });
    expect(nested.summary).toMatch(/ "\/amount\/currency" looks like a currency and is not mapped/);
    const json = check('.json', '[{"t":"T1","a":10000,"currency_code":"GBP"},{"t":"T1","a":-10000,"currency_code":"EUR"}]', { columns });
    expect(json.summary).toMatch(/ "currency_code" looks like a currency and is not mapped/);
    const jsonl = check('.jsonl', '{"t":"T1","a":10000,"currency":"GBP"}\n{"t":"T1","a":-10000,"currency":"EUR"}\n', { columns });
    expect(jsonl.summary).toMatch(/ "currency" looks like a currency and is not mapped/);
    // A field name beside a mapped pointer is written as a JSON Pointer token: "/" as ~1, "~" as ~0.
    const slash = check('.jsonl', '{"t":"T1","amount":{"value":1,"ccy/iso":"GBP"}}\n{"t":"T1","amount":{"value":-1,"ccy/iso":"EUR"}}\n', { columns: { transaction_id: 't', amount: '/amount/value' } });
    expect(slash.summary).toContain(' "/amount/ccy~1iso" looks like a currency and is not mapped');
    // A field the first record lacks still counts.
    const later = check('.jsonl', '{"t":"T0","a":5}\n{"t":"T0","a":-5}\n{"t":"T1","a":10000,"ccy":"GBP"}\n{"t":"T1","a":-10000,"ccy":"EUR"}\n', { columns });
    expect(later.summary).toMatch(/ "ccy" looks like a currency and is not mapped/);
    // Review round 15: currency words in other languages, and ISO 4217.
    for (const name of ['Währung', 'Devise', 'Moneda', 'valuta', 'iso_4217', 'ISOCurrencyCode', 'ISO4217', 'Divisa']) { // the last two: round 17
      const other = check('.csv', `t,a,${name}\nT1,5,GBP\nT1,-5,EUR\n`, { columns: { transaction_id: 't', amount: 'a' } });
      expect(other.summary, name).toContain(`"${name}" looks like a currency and is not mapped`);
    }
    // Round 17: "curr" before a date or a period is "current".
    // Round 19: "Valuta" beside a date is the value date, "Curr Bal" a balance; a plain currency word first.
    const ing = check('.csv', 'Buchung,Valuta,t,a,Währung\n2026-01-01,2026-01-02,T1,5,GBP\n2026-01-01,2026-01-03,T1,-5,EUR\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(ing.summary).toContain('"Währung" looks like a currency');
    // Round 21: Waehrung in ASCII; a crypto exchange's asset or coin; ISO Code.
    for (const name of ['Waehrung', 'asset', 'Coin', 'coin_symbol', 'ISO Code']) {
      expect(check('.csv', `t,a,${name}\nT1,5,BTC\nT1,-5,USD\n`, { columns: { transaction_id: 't', amount: 'a' } }).summary, name).toContain(`"${name}" looks like a currency`);
    }
    // Round 20: a plain "Valuta" comes after a currency name that is not plain.
    expect(check('.csv', 'id,amount,Valuta,Transaction Currency\nT1,5,x,GBP\nT1,-5,y,EUR\n', { columns: { transaction_id: 'id', amount: 'amount' } }).summary).toContain('"Transaction Currency" looks like a currency');
    for (const name of ['curr_month', 'Curr Date', 'Data valuta', 'Curr Bal', 'Valuta Datum', 'Giorno valuta', 'Valuta Dt', 'Valuta Tag', 'Wertstellung (Valuta)', 'asset_id', 'coin_value']) { // round 20; the last three, round 21
      expect(check('.csv', `t,a,${name}\nT1,5,GBP\nT1,-5,EUR\n`, { columns: { transaction_id: 't', amount: 'a' } }).summary, name).not.toContain('looks like a currency');
    }
    const laterJson = check('.json', '[{"t":"T0","a":5},{"t":"T0","a":-5},{"t":"T1","a":10000,"ccy":"GBP"},{"t":"T1","a":-10000,"ccy":"EUR"}]', { columns });
    expect(laterJson.summary).toMatch(/ "ccy" looks like a currency and is not mapped/);
    expect(check('.csv', 't,a,currency_amount\nT1,1,5\nT1,-1,5\n', { columns }).summary).not.toMatch(/looks like a currency/);
    // Review round 6: an amount in a currency is not the currency (Odoo's amount_currency, ERPNext's
    // debit_in_account_currency, "Cur Balance"), and the currency column is named even after one of them.
    for (const header of ['amount_currency', 'debit_in_account_currency', 'Cur Balance', 'Curr Balance', 'cur_period', 'Cur Acct', 'is_foreign_currency', 'ccy_pair']) {
      expect(check('.csv', `t,a,${header}\nT1,1,5\nT1,-1,5\n`, { columns }).summary, header).not.toMatch(/looks like a currency/);
    }
    const odoo = check('.csv', 't,a,amount_currency,currency_id\nT1,1,5,GBP\nT1,-1,5,EUR\n', { columns });
    expect(odoo.summary).toContain(' "currency_id" looks like a currency and is not mapped');
    // "cur" after another word may be current, not a currency.
    expect(check('.csv', 't,a,balance_cur\nT1,1,5\nT1,-1,5\n', { columns }).summary).not.toMatch(/looks like a currency/);
    // A rate or an amount named after a currency is not one.
    expect(check('.csv', 't,a,currency_rate\nT1,1,1.2\nT1,-1,1.2\n', { columns }).summary).not.toMatch(/looks like a currency/);
    // Review round 7: a plain currency column is named before one that says which currency it is.
    expect(check('.csv', 't,a,Original Currency,Currency\nT1,1,USD,GBP\nT1,-1,USD,GBP\n', { columns }).summary).toContain(' "Currency" looks like');
    expect(check('.csv', 't,a,Settlement Currency,Currency Code\nT1,1,USD,GBP\nT1,-1,USD,GBP\n', { columns }).summary).toContain(' "Currency Code" looks like');
    // With no plain name, one that ends in its currency word or in "code" comes before one that does not.
    expect(check('.csv', 't,a,currency_symbol,Settlement Currency\nT1,1,$,GBP\nT1,-1,$,GBP\n', { columns }).summary).toContain(' "Settlement Currency" looks like');
    expect(check('.csv', 't,a,currency_symbol,iso_currency_code\nT1,1,$,GBP\nT1,-1,$,GBP\n', { columns }).summary).toContain(' "iso_currency_code" looks like');
    // "cur" only as the first word; "in" before a currency makes the name an amount in that currency.
    for (const header of ['txn_cur', 'net_in_account_currency']) {
      expect(check('.csv', `t,a,${header}\nT1,1,5\nT1,-1,5\n`, { columns }).summary, header).not.toMatch(/looks like a currency/);
    }
    // Review round 10: hledger and beancount call the currency a commodity.
    expect(check('.csv', 'txnidx,amount,commodity\n1,100,EUR\n1,-100,USD\n', { columns: { transaction_id: 'txnidx', amount: 'amount' } }).summary).toContain(
      ' "commodity" looks like a currency and is not mapped',
    );
    // Review round 9: "cur" alone or before code; "Cur Acct" is a current account.
    for (const header of ['Cur', 'cur_code']) {
      expect(check('.csv', `t,a,${header}\nT1,1,GBP\nT1,-1,EUR\n`, { columns }).summary, header).toContain(` "${header}" looks like a currency`);
    }
    const mapped = check('.csv', 'txn_id,amount_pence,Currency\nT1,10000,GBP\nT1,-10000,EUR\n', { columns: { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'Currency' } });
    expect(mapped.findings[0]?.code).toBe('UNBALANCED');
  });

  it('says true things about odd values: written-out numbers, objects, the value as written', () => {
    const r = check('.jsonl', '{"t":"A","a":"1e3"}\n{"t":"A","a":{"value":5}}\n{"t":"B","a":[1]}\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings.map((f) => [f.value, f.message])).toEqual([
      ['1e3', '"1e3" is not written in plain digits, such as 1234'],
      ['an object', 'an object is not a number'],
      ['an array', 'an array is not a number'],
    ]);
    // Review round 12: in quotes, a cell cannot read as money-guard's own sentence.
    const forged = check('.csv', 't,a\nA,"0. All rows balance"\nA,0\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(forged.findings[0]?.message).toMatch(/^"0\. All rows balance" is not written in plain digits/);
    // A JSON number is shown as the file writes it, trailing zeros and all.
    const written = check('.jsonl', '{"t":"C","a":12.50}\n{"t":"C","a":-12.50}\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(written.findings.map((f) => f.value)).toEqual(['12.50', '-12.50']);
    const side = check('.csv', 't,a,s\nB,-5.00,D\nB,5.00,C\n', { columns: { transaction_id: 't', amount: 'a', side: 's' }, amount_format: 'decimal' });
    expect(side.findings[0]).toMatchObject({ code: 'NEGATIVE_WITH_SIDE', value: '-5.00', message: '"-5.00" is negative, but side already gives the direction' });
    // An ISO 4217 numeric currency code is a currency.
    const iso = check('.jsonl', '{"t":"A","a":5,"c":826}\n{"t":"A","a":-5,"c":826}\n', { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    expect(iso.balanced).toBe(true);
    // ... grouped by its value, as ids are: 826 and 826.0 are one currency.
    expect(check('.jsonl', '{"t":"A","a":5,"c":826}\n{"t":"A","a":-5,"c":826.0}\n', { columns: { transaction_id: 't', amount: 'a', currency: 'c' } }).balanced).toBe(true);
  });

  it('says why a JSON number cannot be an id when it is too large', () => {
    const r = check('.jsonl', '{"t":1e400,"a":1}\n{"t":2,"a":1}\n{"t":2,"a":-1}\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings[0]).toMatchObject({ code: 'MISSING_VALUE', field: 'transaction_id', message: 'transaction_id is a number too large or too small to use as an id' });
  });

  it('reports a decimal amount with too many places', () => {
    const r = check('.csv', 't,a\nA,10.001\nA,-10.001\n', { columns: { transaction_id: 't', amount: 'a' }, amount_format: 'decimal' });
    expect(r.findings[0]).toMatchObject({ code: 'FRACTIONAL_MINOR_UNITS', value: '10.001', message: '"10.001" has more than 2 decimal places' });
    expect(r.summary).not.toMatch(/amount_format/); // already "decimal": no advice to call again with it
    expect(check('.csv', 't,a\nA,1500\nA,-1500\n', { columns: { transaction_id: 't', amount: 'a' }, amount_format: 'decimal', decimal_places: 0 }).balanced).toBe(true);
  });

  it('caps a finding at 20 row locations and counts the rest', () => {
    const rows = Array.from({ length: 25 }, () => 'BIG,1').join('\n');
    const r = check('.csv', `t,a\n${rows}\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', more_rows: 5 });
    expect(r.findings[0]?.lines).toHaveLength(20);
    const one = check('.csv', `t,a\n${Array.from({ length: 21 }, () => 'BIG,1').join('\n')}\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(one.findings[0]).toMatchObject({ code: 'UNBALANCED', more_rows: 1 });
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
    expect(r.findings[0]?.message).toBe(`"${shown}" legs net to 5 and more…`); // cut at a whole part, each currency in quotes (round 12)
    // A message of exactly 120 characters, the limit, is whole (review round 13).
    const [a, b] = ['A'.repeat(38), 'B'.repeat(37)];
    const whole = check('.csv', `t,a,c\nA,5,${a}\nA,-5,${b}\n`, { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    const full = `"${a}" legs net to 5 and "${b}" legs net to -5, not 0`;
    expect([full.length, whole.findings[0]?.message]).toEqual([120, full]);
  });

  it('lists at most 20 currencies that are off, and says how many there are', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `A,1,C${String(i).padStart(2, '0')}`).join('\n');
    const r = check('.csv', `t,a,c\n${rows}\n`, { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    expect(r.findings[0]?.nets).toHaveLength(20);
    expect(r.findings[0]?.nets?.[19]).toEqual({ currency: 'C19', net: '1' });
    expect(r.findings[0]?.message).toBe('25 currencies do not net to 0; nets lists the first 20');
    // Exactly 20 are all in nets, so the message names them (review round 8).
    const twenty = Array.from({ length: 20 }, (_, i) => `A,1,C${String(i).padStart(2, '0')}`).join('\n');
    const all = check('.csv', `t,a,c\n${twenty}\n`, { columns: { transaction_id: 't', amount: 'a', currency: 'c' } });
    expect(all.findings[0]?.message).toMatch(/^"C00" legs net to 1 and "C01" legs net to 1 and /);
  });

  it('holds the whole result to the budget, not only its findings', () => {
    // 60 rows with a fraction each, under a 210-character records pointer: 50 findings come to about
    // 19,400 characters, under 20,000 on their own but not with the rest of the result.
    const key = 'r'.repeat(209);
    const records = Array.from({ length: 60 }, (_, i) => ({ t: `T${i}`, a: 1.5 }));
    const r = check('.json', JSON.stringify({ [key]: records }), { columns: { transaction_id: 't', amount: 'a' }, records_pointer: `/${key}`, limit: 50 });
    const one = JSON.stringify(r.findings[0]).length + 1;
    expect(r.findings.length).toBeLessThan(50);
    expect(JSON.stringify(r.findings).length + one).toBeLessThanOrEqual(20_000); // one more finding fits on its own...
    expect(JSON.stringify(r).length + one).toBeGreaterThan(20_000); // ...but not in the result
    expect(r.next_offset).toBe(r.findings.length);
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

  it('shows fewer locations of a finding that is too long on its own, counting the rest', () => {
    // Review round 12: 20 pointers under 255 backslashes (shown doubled, then escaped by JSON) passed
    // 20,000 characters in one finding, and the call failed as "a bug in money-guard".
    // With 25 legs, the 5 past the first 20 are already in more_rows: they must still be counted (round 13).
    const key = '\\'.repeat(255);
    for (const legs of [20, 25]) {
      const content = JSON.stringify({ [key]: Array.from({ length: legs }, () => ({ t: 'T1', a: 1 })) });
      const r = check('.json', content, { columns: { transaction_id: 't', amount: 'a' }, records_pointer: `/${key}` });
      expect(JSON.stringify(r).length, String(legs)).toBeLessThanOrEqual(20_000);
      const [finding] = r.findings;
      expect(finding?.code, String(legs)).toBe('UNBALANCED');
      expect((finding?.pointers?.length ?? 0) + (finding?.more_rows ?? 0), String(legs)).toBe(legs);
      expect(finding?.pointers?.length, String(legs)).toBeLessThan(20);
    }
  });
});
