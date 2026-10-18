// Limits tested at their edge, and the rarer forms of a few answers (review round 19, found by mutation:
// each of these could change by one, or lose a case, with every other test still passing). Kept apart
// from the files they belong to, which are at or near 400 lines.
import { describe, expect, it } from 'vitest';
import { overBudget } from '../src/budget.js';
import { closest } from '../src/closest.js';
import { collectSources } from '../src/lint/files.js';
import { check } from './support/ledger.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

const errorText = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    return (err as { toText(): string }).toText();
  }
  return '';
};

describe('limits at their edge', () => {
  it('counts a result of exactly 20,000 characters as within the budget, and 20,001 as over', () => {
    const sized = (n: number) => ({ s: 'x'.repeat(n - '{"s":""}'.length) });
    expect([JSON.stringify(sized(20_000)).length, overBudget(sized(20_000)), overBudget(sized(20_001))]).toEqual([20_000, false, true]);
  });

  it('reads a JSON file of exactly 1,000,000 records, and refuses one more', () => {
    const records = (n: number) => `[${'{"t":"A","a":0},'.repeat(n - 1)}{"t":"A","a":0}]`;
    const columns = { transaction_id: 't', amount: 'a' };
    expect(errorText(() => check('.json', records(1_000_001), { columns }))).toMatch(/^TOO_MANY_ROWS: The file has more than 1,000,000 rows\./);
    expect(check('.json', records(1_000_000), { columns }).rows_read).toBe(1_000_000);
  });

  it('shows a records_pointer key of exactly 40 characters whole, and one of 41 cut', () => {
    // Review round 22: up to 200, a key could be a whole secret; past 40 no name is shown whole.
    const hint = (key: string) => errorText(() => check('.json', JSON.stringify({ [key]: [] }), { columns: { transaction_id: 'id', amount: 'a' } }));
    expect(hint('k'.repeat(40))).toContain(`Pass records_pointer "/${'k'.repeat(40)}", the one field there that holds an array.`);
    expect(hint('k'.repeat(41))).toContain(`Pass records_pointer "/${'k'.repeat(39)}…", the one field there that holds an array.`);
  });

  it('reads a CSV row of exactly 10,000 fields, and refuses one of 10,001', () => {
    const row = (fields: number) => `T1,0${','.repeat(fields - 2)}`;
    const columns = { transaction_id: 'a', amount: 'b' };
    expect(errorText(() => check('.csv', `a,b\n${row(10_000)}\n`, { columns }))).not.toContain('more than 10,000 fields');
    expect(errorText(() => check('.csv', `a,b\n${row(10_001)}\n`, { columns }))).toContain('a row holds more than 10,000 fields');
  });

  it('takes a .sql file of exactly 5 MiB, and refuses one byte more', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 2)}`, 'db/more/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 1)}` });
    expect(collectSources(rootOf(dir), { migrations: 'db/migrations' }).files).toHaveLength(1);
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'db/more' }))).toMatch(/^FILE_TOO_LARGE: /);
  });
});

describe('time that grows with a name', () => {
  it('reads a header cell of 40,000 words in linear time', () => {
    // Review round 20: "valuta " × 40,000 + "date" took 19 s, each "valuta" scanning every word again. Since
    // round 24 the hint reads only what is shown, so the date word past 40 characters is not seen.
    const started = performance.now();
    const r = check('.csv', `t,a,${'valuta '.repeat(40_000)}date\nT1,5,x\nT1,-5,y\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.summary).toContain(`"${'valuta '.repeat(5)}valu…" looks like a currency`);
    expect(check('.csv', `t,a,valuta date\nT1,5,x\nT1,-5,y\n`, { columns: { transaction_id: 't', amount: 'a' } }).summary).not.toContain('looks like a currency'); // Valuta beside a date word
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('the rarer forms of an answer', () => {
  it('writes a key with "/" or "~" as a JSON Pointer token in the records_pointer it suggests', () => {
    expect(errorText(() => check('.json', '{"a/b~c":[]}', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(/Fix: Pass records_pointer "\/a~1b~0c", the one field there that holds an array\.$/);
  });

  it('says when a CSV has no header line, and warns when a mapped column is named like a value', () => {
    // Review round 20: the data cells were offered as names ("Did you mean "T1"?"), and mapped as offered,
    // the first row (T1, 999: unbalanced) was read as the header and the file came back balanced.
    const csv = 'T1,999,GBP\nT2,50,GBP\nT2,-50,GBP\n';
    const e = errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt' } }));
    expect(e).toContain(' The first line holds "999", written like a value: the first line is always read as the column names, so a file without a header line loses its first row.');
    expect(e).not.toContain('Did you mean');
    expect(e).toMatch(/Fix: Map each field to one of the column names in the header; if the file has no header line, add one that names the columns first\.$/);
    // Round 21: a real header may name a column "2023"; the closest match is kept.
    expect(errorText(() => check('.csv', 'id,amount,2023\nT1,5,1\nT1,-5,1\n', { columns: { transaction_id: 'id', amount: 'amout' } }))).toContain('Did you mean "amount"?');
    expect(check('.csv', csv, { columns: { transaction_id: 'T1', amount: '999' } }).summary).toContain(' The mapped column "999" is named like a value: if the file has no header line, its first row was read as the column names, and was not checked.');
    expect(check('.csv', 'id,amount\nT1,5\nT1,-5\n', { columns: { transaction_id: 'id', amount: 'amount' } }).summary).not.toContain('named like a value');
  });

  it('says an amount with a comma needs converting, whatever the format', () => {
    // Review round 21: "1,50" was only "not a decimal amount such as 12.34".
    for (const amount_format of ['decimal', 'minor_units'] as const) {
      for (const amount of ['1,50', '1,500', '1,234.56', '1.234,56']) {
        const r = check('.csv', `t;a\nT1;${amount}\nT1;-1\n`, { columns: { transaction_id: 't', amount: 'a' }, delimiter: ';', amount_format });
        expect(r.findings[0]?.message, `${amount_format} ${amount}`).toContain('has a comma: write it as a plain amount');
      }
      // Round 22: the longest value shown and this reason stay within a finding's 120 characters.
      const long = check('.csv', `t;a\nT1;${'1,'.repeat(30)}1\nT1;-1\n`, { columns: { transaction_id: 't', amount: 'a' }, delimiter: ';', amount_format });
      expect([...(long.findings[0]?.message ?? '')].length, amount_format).toBeLessThanOrEqual(120);
    }
  });

  it('reads every header cell for one written like a value, and only whole values', () => {
    const e = (csv: string, columns: Record<string, string>, extra: Record<string, unknown> = {}) => errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amount', ...columns }, ...extra }));
    expect(e('2024,abc,def\n1,2,3\n', {})).toContain('The first line holds "2024", written like a value'); // the first cell too
    expect(e('id,1st payment\nT1,5\n', {})).not.toContain('written like a value'); // "1st payment" is a name
    // With another delimiter likelier, the delimiter fix, and no data note's fix.
    expect(e('100;T1;GBP\n', {})).toMatch(/Fix: The file looks separated by ";", not ",": pass delimiter ";"\.$/);
    // "1,50" read with ";" is both written like a value and separated by ",": the delimiter fix comes first.
    expect(e('1,50\n2,50\n', {}, { delimiter: ';' })).toMatch(/Fix: The file looks separated by ",", not ";": pass delimiter ","\.$/);
    // JSONL keys named like values get no header hint: JSON has no header line.
    expect(check('.jsonl', '{"999":"T1","5":5}\n{"999":"T1","5":-5}\n', { columns: { transaction_id: '999', amount: '5' } }).summary).not.toContain('named like a value');
  });

  it('never gives back more than 40 characters of a first-line cell, however it is asked', () => {
    // Review round 22: shown 40 characters, a model sent them with 13 more guessed and got the whole token
    // back in "Did you mean". A file the secrets list misses is read as a ledger, its first line as names.
    const token = 'sk_live_51HxQ2ZKa8Jd93kLmNoPqRsTuVwXyZ01HIDDENPART77';
    const csv = `stripe,${token}\n`;
    for (const amount of [token.slice(0, 40), `${token.slice(0, 40)}${'x'.repeat(13)}`, `${token.slice(0, 39)}…`, token.slice(0, 50)]) {
      // transaction_id maps a column that is there, so the error is about the amount column, the probe.
      const fromCsv = errorText(() => check('.csv', csv, { columns: { transaction_id: 'stripe', amount } }));
      if (!amount.endsWith('…')) expect(fromCsv, amount).toContain('(mapped as amount)'); // passed back as shown, it maps
      expect(fromCsv, amount).not.toContain('HIDDENPART');
      const fromJson = errorText(() => check('.jsonl', `{"t":"T1","${token}":1}\n`, { columns: { transaction_id: 't', amount } })); // a JSON key too
      if (!amount.endsWith('…')) expect(fromJson, amount).toContain('(mapped as amount)');
      expect(fromJson, amount).not.toContain('HIDDENPART');
    }
    // Review round 23: whether a suggestion comes at all must say nothing past what is shown. Guessing the
    // first hidden character after the 39 shown, every guess gets the same answer, so none can be told right.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_';
    const known = token.slice(29, 39);
    const answers = (probe: (c: string) => () => unknown) => new Set([...alphabet].map((c) => errorText(probe(c)).includes('Did you mean')));
    expect(answers((c) => () => check('.csv', csv, { columns: { transaction_id: 'stripe', amount: `${known}${c}` } })).size).toBe(1);
    expect(answers((c) => () => check('.jsonl', `{"t":"T1","${token}":1}\n`, { columns: { transaction_id: 't', amount: `${known}${c}` } })).size).toBe(1);
    expect(answers((c) => () => check('.csv', csv, { columns: { transaction_id: 'stripe', amount: `${token.slice(0, 37)}${c}${'x'.repeat(14)}` } })).size).toBe(1); // by edit distance too
    // A cut name maps only when one name is shown so: two that share their first 39 characters do not.
    const twins = `${'x'.repeat(39)}aa,${'x'.repeat(39)}bb,amount\nT1,T1,5\nT1,T1,-5\n`;
    expect(errorText(() => check('.csv', twins, { columns: { transaction_id: `${'x'.repeat(39)}…`, amount: 'amount' } }))).toMatch(/^COLUMN_NOT_FOUND: /);
  });

  it('says a suggestion that looks like the name given, cut, differs past what is shown', () => {
    // Review round 23: the two read the same, as a contradiction.
    const long = 'Transaction Identifier For The General Ledger Entry';
    const cutName = `${long.slice(0, 39)}…`;
    expect(errorText(() => check('.csv', `${long},amount_pence\nA,1\n`, { columns: { transaction_id: `${long.slice(0, 45)}x`, amount: 'amount_pence' } })))
      .toContain(`no column "${cutName}" (mapped as transaction_id). Did you mean "${cutName}" (it differs past the 40 characters shown: pass it back as shown)?`);
  });

  it('shows two long names that begin alike by their ends too, so each can be mapped as shown', () => {
    // Review round 23: both showed as "Transaction amount in settlement curren…", and neither could be mapped.
    const gbp = 'Transaction amount in settlement currency (GBP)';
    const csv = `id,${gbp},Transaction amount in settlement currency (EUR)\nT1,5,1\nT1,-5,-1\n`;
    const e = errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amount' } }));
    const shown = [...e.matchAll(/"(Transaction[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(new Set(shown).size).toBe(2); // two different names
    const mine = shown.find((s) => s.includes('GBP')) ?? '';
    expect([mine.length <= 40, check('.csv', csv, { columns: { transaction_id: 'id', amount: mine } }).rows_read]).toEqual([true, 2]);
    // A cut name with a quote in it maps written as shown (\\") or plainly (").
    const quotedName = 'Amount "net" in the settlement currency of the row';
    const q = `id,"${quotedName.replaceAll('"', '""')}"\nT1,5\nT1,-5\n`;
    const listed = (errorText(() => check('.csv', q, { columns: { transaction_id: 'id', amount: 'x' } })).match(/"(Amount[^…]*…)"/) ?? [])[1] ?? '';
    expect(listed).toContain('\\"net\\"');
    expect([check('.csv', q, { columns: { transaction_id: 'id', amount: listed } }).rows_read, check('.csv', q, { columns: { transaction_id: 'id', amount: listed.replaceAll('\\"', '"') } }).rows_read]).toEqual([2, 2]);
  });

  it('says in the ledger summary when more findings follow, as the lint does', () => {
    // Review round 23: page 1 of 45 unbalanced transactions read as if its 20 findings were all.
    const csv = `t,a\n${Array.from({ length: 45 }, (_, i) => `T${i},5`).join('\n')}\n`;
    const first = check('.csv', csv, { columns: { transaction_id: 't', amount: 'a' }, limit: 20 });
    expect([first.next_offset, first.summary.endsWith(' Not every finding is listed: pass next_offset as offset for the next ones.')]).toEqual([20, true]);
    const last = check('.csv', csv, { columns: { transaction_id: 't', amount: 'a' }, limit: 20, offset: 40 });
    expect([last.next_offset, last.summary.includes('Not every finding is listed')]).toEqual([null, false]);
  });

  it('suggests no name as far from the one asked for as its whole length', () => {
    expect([closest('id', ['1']), closest('id', ['ab']), closest('amount', ['amonut']), closest('id', ['ids'])]).toEqual([undefined, undefined, 'amonut', 'ids']);
    // Round 22: failing that, a name that holds the whole one asked for, of three letters or more.
    expect([closest('amount', ['txn_id', 'Amount_Pence']), closest('id', ['txn_identifier']), closest('pence', ['amount', 'amount_pence', 'pence_total'])]).toEqual(['Amount_Pence', undefined, 'amount_pence']);
  });

  it('suggests a records_pointer that quotes show escaped, which passed back as shown reaches the array', () => {
    // Review round 20: for the key ledger\\rows the fix showed "/ledger\\\\rows", which, passed back, led nowhere;
    // so no pointer was suggested. Since round 24 a pointer passed back as shown is read as shown.
    const columns = { transaction_id: 'id', amount: 'a' };
    for (const [key, shown] of [['ledger\\rows', '/ledger\\\\rows'], ['say "hi"', '/say \\"hi\\"']] as const) {
      const file = JSON.stringify({ [key]: [{ id: 'T1', a: 0 }], n: 1 });
      expect(errorText(() => check('.json', file, { columns })), key).toContain(`Pass records_pointer "${shown}", the one field`);
      expect(check('.json', file, { columns, records_pointer: shown }).rows_read, key).toBe(1);
    }
  });

  it('says which fields of columns clash', () => {
    const why = (columns: Record<string, string>) => errorText(() => check('.csv', 'id,a,d,c,s\nT1,1,1,1,D\n', { columns: { transaction_id: 'id', ...columns } })).replace(/^.*Here /, '').replace(/ Fix: .*$/, '');
    expect([why({ amount: 'a', debit: 'd' }), why({ amount: 'a', debit: 'd', credit: 'c' }), why({ debit: 'd' }), why({ credit: 'c' }), why({ side: 's' }), why({})]).toEqual([
      'amount cannot be mapped with debit.', 'amount cannot be mapped with debit and credit.', 'debit needs credit too.', 'credit needs debit too.', 'side goes with amount, which is not mapped.', 'none of amount, debit and credit is mapped.',
    ]);
  });

  it('gives the advice for code to a Python migration as to a TypeScript one', () => {
    const dir = tempDir();
    writeTree(dir, { 'mig/0001_init.py': 'pass' });
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'mig/0001_init.py' }))).toMatch(/^FILE_TYPE_NOT_ALLOWED: .* Migrations written as code \(Knex, TypeORM, Django, Alembic\) need SQL first/);
  });
});
