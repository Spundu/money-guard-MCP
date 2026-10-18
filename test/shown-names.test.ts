// Names and JSON Pointers as results show them (SPEC.md §2.4, §4.7; review round 24): every hint is judged
// on what is shown of a name, at most 40 characters, so nothing past them changes an answer; and every name
// or pointer a result shows, cut or escaped, reaches what it names when it is passed back.
import { describe, expect, it } from 'vitest';
import { check } from './support/ledger.js';

const errorText = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    return (err as { toText(): string }).toText();
  }
  return '';
};

/** The records_pointer a RECORDS_NOT_ARRAY fix suggests. */
const suggested = (text: string) => /Pass records_pointer "((?:[^"\\]|\\.)*)", the one field/.exec(text)?.[1];

describe('a records_pointer passed back as shown', () => {
  it('reaches records under a key past 40 characters, or one with a hidden character', () => {
    const columns = { transaction_id: 'id', amount: 'a' };
    for (const [key, shown] of [['r'.repeat(250), `/${'r'.repeat(39)}…`], ['rows\u{200b}', '/rows\\u200b']] as const) {
      const file = JSON.stringify({ [key]: [{ id: 'T1', a: 0 }], meta: {} });
      expect(suggested(errorText(() => check('.json', file, { columns }))), key).toBe(shown);
      expect(check('.json', file, { columns, records_pointer: shown }).rows_read, key).toBe(1);
    }
  });

  it('reaches records under a cut key one level down, and leads nowhere for a cut form two keys share', () => {
    const columns = { transaction_id: 'id', amount: 'a' };
    const file = JSON.stringify({ export: { [`${'e'.repeat(45)}_rows`]: [{ id: 'T1', a: 0 }], n: 1 } });
    expect(suggested(errorText(() => check('.json', file, { columns, records_pointer: '/export' })))).toBe(`/export/${'e'.repeat(39)}…`);
    expect(check('.json', file, { columns, records_pointer: `/export/${'e'.repeat(39)}…` }).rows_read).toBe(1);
    const two = JSON.stringify({ [`${'e'.repeat(45)}_a`]: [], [`${'e'.repeat(45)}_b`]: [] });
    expect(errorText(() => check('.json', two, { columns, records_pointer: `/${'e'.repeat(39)}…` }))).toMatch(/^RECORDS_NOT_ARRAY: The value at "\/e+…" is nothing/);
  });
});

describe('a column name passed back as a hint showed it', () => {
  it('maps a nested currency field past 40 characters as the currency hint shows it', () => {
    const key = 'currency_code_as_reported_by_the_bank_of_issue';
    const file = JSON.stringify([{ id: 'T1', money: { value: 5, [key]: 'GBP' } }, { id: 'T1', money: { value: -5, [key]: 'GBP' } }]);
    const shown = `/money/${key.slice(0, 39)}…`;
    expect(check('.json', file, { columns: { transaction_id: 'id', amount: '/money/value' } }).summary).toContain(`"${shown}" looks like a currency and is not mapped`);
    const mapped = check('.json', file, { columns: { transaction_id: 'id', amount: '/money/value', currency: shown } });
    expect([mapped.rows_read, mapped.summary]).toEqual([2, 'Balanced: the 1 transaction nets to zero in whole minor units.']);
  });

  it('maps one of two CSV headers that begin alike as the currency hint shows it, cut in the middle', () => {
    const csv = 'id,amt,Currency Code As Reported By The Issuing Bank Alpha,Currency Code As Reported By The Issuing Bank Beta\nT1,5,GBP,x\nT1,-5,GBP,y\n';
    const hint = /"([^"]+)" looks like a currency/.exec(check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt' } }).summary)?.[1] ?? '';
    expect(hint).toBe('Currency Code As Re…e Issuing Bank Alpha');
    expect(check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt', currency: hint } }).summary).not.toContain('looks like a currency');
  });

  it('suggests a nested field as a pointer that, passed back, is read', () => {
    const records = (parent: string) => JSON.stringify([{ [parent]: { transaction_identifier_value: 'T1' }, amt: 5 }, { [parent]: { transaction_identifier_value: 'T1' }, amt: -5 }]);
    for (const [parent, shown] of [['meta_block_for_txn', 'meta_block_for_txn'], ['m'.repeat(50), `${'m'.repeat(39)}…`]] as const) {
      const file = records(parent);
      const pointer = `/${shown}/transaction_identifier_value`;
      expect(errorText(() => check('.json', file, { columns: { transaction_id: 'transaction_identifier_value', amount: 'amt' } })), parent).toContain(`Did you mean "${pointer}"?`);
      expect(check('.json', file, { columns: { transaction_id: pointer, amount: 'amt' } }).summary, parent).toMatch(/^Balanced/);
    }
  });

  it('maps a long field only a later record has, as the hint shows it, in JSON and JSONL', () => {
    const key = 'currency_code_as_reported_by_the_bank_of_issue';
    const records = [{ id: 'T1', amt: 5 }, { id: 'T1', amt: -5, [key]: 'GBP' }];
    const columns = { transaction_id: 'id', amount: 'amt', currency: `${key.slice(0, 39)}…` };
    for (const [ext, text] of [['.json', JSON.stringify(records)], ['.jsonl', records.map((r) => JSON.stringify(r)).join('\n')]] as const) {
      expect(errorText(() => check(ext, text, { columns })), ext).toBe('');
    }
  });

  it('shows two keys of a records_pointer target that begin alike each cut in the middle', () => {
    const file = JSON.stringify({ [`${'e'.repeat(45)}_a`]: 1, [`${'e'.repeat(45)}_b`]: 2 });
    expect(errorText(() => check('.json', file, { columns: { transaction_id: 'id', amount: 'a' } }))).toContain(`keys "${'e'.repeat(19)}…${'e'.repeat(18)}_a", "${'e'.repeat(19)}…${'e'.repeat(18)}_b"`);
  });

  it('lists two CSV headers that begin alike each cut in the middle, and maps each as listed', () => {
    // Review round 24: only the JSON path was tested; a plain cut in the CSV list would bring back round 23's bug.
    const [a, b] = ['Currency Code As Reported By The Issuing Bank Alpha', 'Currency Code As Reported By The Issuing Bank Betaa'];
    const csv = `id,amt,${a},${b}\nT1,5,GBP,EUR\nT1,-5,GBP,EUR\n`;
    const text = errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt', currency: 'nope' } }));
    const listed = ['Currency Code As Re…e Issuing Bank Alpha', 'Currency Code As Re…e Issuing Bank Betaa'];
    expect(text).toContain(`"id", "amt", "${listed[0]}", "${listed[1]}"`);
    for (const name of listed) expect(check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt', currency: name } }).summary, name).toMatch(/^Balanced/);
  });

  it('marks two names that show alike even cut in the middle with their place, and maps each as marked', () => {
    // Review round 24: both showed as "Amount (minor units… settled by the bank"; passed back, that mapped neither,
    // and the hint said to pass it back as shown, so a model looped.
    const [debit, credit] = ['debit', 'credit'].map((side) => `Amount (minor units) of the ledger line - ${side} side - as settled by the bank`);
    const csv = `id,${debit},${credit}\nT1,5,0\nT1,0,5\n`;
    const cut = 'Amount (minor units… settled by the bank';
    const text = errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', debit: 'Debit', credit: cut } }));
    expect(text).toContain(`"${cut} #1", "${cut} #2"`);
    expect(text).not.toContain('pass it back as shown');
    const mapped = check('.csv', csv, { columns: { transaction_id: 'id', debit: `${cut} #1`, credit: `${cut} #2` } });
    expect([mapped.rows_read, mapped.summary]).toEqual([2, 'Balanced: the 1 transaction nets to zero in whole minor units.']);
  });

  it('shows a suggestion that is the first name, and collides, as the list shows it', () => {
    const csv = `${'q'.repeat(45)}_x,${'q'.repeat(45)}_y,amt\nT1,0,5\nT1,0,-5\n`;
    expect(errorText(() => check('.csv', csv, { columns: { transaction_id: `${'q'.repeat(45)}_z`, amount: 'amt' } }))).toContain(`Did you mean "${'q'.repeat(19)}…${'q'.repeat(18)}_x"`);
  });

  it('shows a pointer of up to 8 tokens before its last token by token, a longer one cut whole', () => {
    // Review round 25: `> SHOWN_TOKENS + 1` made `>=` was caught by no test.
    const long = 'p'.repeat(50);
    const hint = (inner: number) => {
      const ks = Array.from({ length: inner }, (_, i) => `k${inner - 1 - i}`);
      const record = (value: number) => {
        let node: unknown = { value, currency: 'GBP' };
        for (const k of [...ks].reverse()) node = { [k]: node };
        return { id: 'T1', [long]: node };
      };
      const file = JSON.stringify([record(5), record(-5)]);
      return check('.json', file, { columns: { transaction_id: 'id', amount: `/${[long, ...ks, 'value'].join('/')}` } }).summary;
    };
    // Eight tokens before "currency": each shown, the first cut on its own.
    expect(hint(7)).toContain(`"/${'p'.repeat(39)}…/k6/k5/k4/k3/k2/k1/k0/currency" looks like a currency`);
    // Nine: the whole name is cut, in the middle, as it begins like the amount's.
    expect(hint(8)).toContain(`"/${'p'.repeat(18)}…k3/k2/k1/k0/currency" looks like a currency`);
  });

  it('describes an object’s keys as pointer tokens, each among all the keys, as uncutPointer reads them back', () => {
    // Review round 25: shown among the first 20 alone, a key whose twin came later was cut at its head.
    const e = 'e'.repeat(45);
    const rows = { 'a/b': 1, [`${e}_x`]: 1, ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`k${i}`, 1])), [`${e}_y`]: 1 };
    const text = errorText(() => check('.json', JSON.stringify({ rows }), { columns: { transaction_id: 'id', amount: 'a' }, records_pointer: '/rows' }));
    expect(text).toContain(`keys "a~1b", "${'e'.repeat(19)}…${'e'.repeat(18)}_x", "k0"`);
  });

  it('describes an object of exactly 20 keys with no ellipsis, and one of 21 with it', () => {
    const keys = (n: number) => JSON.stringify({ rows: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1])) });
    const columns = { transaction_id: 'id', amount: 'a' };
    expect(errorText(() => check('.json', keys(20), { columns, records_pointer: '/rows' }))).toMatch(/"k19", not an array/);
    expect(errorText(() => check('.json', keys(21), { columns, records_pointer: '/rows' }))).toMatch(/"k19", …, not an array/);
  });

  it('lists exactly 30 names with no "and 0 more", in a CSV header and in a JSON record', () => {
    // Round 24's tests: "> 30" made ">= 30" was caught by no test.
    const names = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const csv = errorText(() => check('.csv', `${names.join(',')}\n${names.map(() => '1').join(',')}\n`, { columns: { transaction_id: 'x', amount: 'c1' } }));
    const json = errorText(() => check('.json', JSON.stringify([Object.fromEntries(names.map((n) => [n, 1]))]), { columns: { transaction_id: 'x', amount: 'c1' } }));
    for (const text of [csv, json]) expect(text).toMatch(/"c29"\. /);
  });

  it('reads a JSONL file the same way, with the names of its first records', () => {
    const key = 'currency_code_as_reported_by_the_bank_of_issue';
    const jsonl = `{"id":"T1","money":{"value":5,"${key}":"GBP"}}\n{"id":"T1","money":{"value":-5,"${key}":"GBP"}}\n`;
    const mapped = check('.jsonl', jsonl, { columns: { transaction_id: 'id', amount: '/money/value', currency: `/money/${key.slice(0, 39)}…` } });
    expect(mapped.summary).toBe('Balanced: the 1 transaction nets to zero in whole minor units.');
  });
});

describe('every hint shows a name as its resolver reads it back (review round 25)', () => {
  // A name's shown form depends on the names beside it; each hint had built its own list.
  const fieldsListed = (text: string) => [...(/The first record's fields are: (.*?)\. Fix:/.exec(text)?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');

  it('lists the first record’s fields as among the names of later records too, and each maps as listed', () => {
    const key = 'transaction_identifier_as_written_by_the_bank';
    const records = [{ [`${key}_primary`]: 'T1', amt: 5 }, { [`${key}_primary`]: 'T1', amt: -5 }, { [`${key}_primary`]: 'T2', [`${key}_secondary`]: 'x', amt: 0 }];
    for (const [ext, text] of [['.json', JSON.stringify(records)], ['.jsonl', records.map((r) => JSON.stringify(r)).join('\n')]] as const) {
      const listed = fieldsListed(errorText(() => check(ext, text, { columns: { transaction_id: 'txn', amount: 'amt' } })));
      expect(listed, ext).toEqual(['transaction_identif…_by_the_bank_primary', 'amt']);
      expect(check(ext, text, { columns: { transaction_id: listed[0] ?? '', amount: 'amt' } }).rows_read, ext).toBe(3);
    }
  });

  it('suggests a records_pointer beside a sibling that begins alike, cut as its object shows it', () => {
    const key = 'general_ledger_journal_entries_exported_from_xero';
    const file = JSON.stringify({ [key]: [{ id: 'T1', a: 0 }], [`${key}_meta`]: {} });
    const pointer = suggested(errorText(() => check('.json', file, { columns: { transaction_id: 'id', amount: 'a' } })));
    expect(pointer).toBe(`/${key.slice(0, 19)}…${key.slice(-20)}`);
    expect(check('.json', file, { columns: { transaction_id: 'id', amount: 'a' }, records_pointer: pointer ?? '' }).rows_read).toBe(1);
  });

  it('never marks a name with a mark another name shows: "Amt #1" beside two "Amt"', () => {
    const csv = 'id,Amt #1,Amt,Amt\nT1,3,1,7\nT1,-3,-1,0\n';
    expect(errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'nope' } }))).toContain('"id", "Amt #1", "Amt #2", "Amt #3"');
    expect(check('.csv', csv, { columns: { transaction_id: 'id', amount: 'Amt #1' } }).summary).toMatch(/^Balanced/);
  });

  it('suggests a field beside the one a mapped pointer names, close to it', () => {
    const file = JSON.stringify([{ id: 'T1', amount: { value: 5, currency_code: 'GBP' } }, { id: 'T1', amount: { value: -5, currency_code: 'GBP' } }]);
    const columns = { transaction_id: 'id', amount: '/amount/value' };
    expect(errorText(() => check('.json', file, { columns: { ...columns, currency: '/amount/curency_code' } }))).toContain('Did you mean "/amount/currency_code"?');
    expect(errorText(() => check('.json', file, { columns: { ...columns, transaction_id: '/idd' } }))).toContain('Did you mean "/id"?');
  });
});

describe('nothing past the 40 characters shown changes an answer', () => {
  // Review round 24: the currency hint, the "written like a value" note and the delimiter hint were judged on whole
  // first-line cells, so whether they came, or what they named, told what lay past what is shown.
  const csvAnswer = (header: string, columns: Record<string, string>) => {
    const text = errorText(() => check('.csv', `${header}\nT1,5,GBP\nT1,-5,GBP\n`, { columns: { transaction_id: 'id', amount: 'amt', ...columns } }));
    return text === '' ? check('.csv', `${header}\nT1,5,GBP\nT1,-5,GBP\n`, { columns: { transaction_id: 'id', amount: 'amt', ...columns } }).summary : text;
  };

  it('gives the same currency hint whatever a long name ends in', () => {
    const answers = ['_zz', '_amount', '_code'].map((tail) => csvAnswer(`id,amt,currency_${'x'.repeat(40)}${tail}`, {}));
    expect(new Set(answers).size).toBe(1);
  });

  it('gives the same answer for a first line past 40 characters whether its end is a value or a word', () => {
    const answers = ['9', 'x'].map((tail) => csvAnswer(`${'1'.repeat(45)}${tail},amt,c`, { transaction_id: 'nope' }));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('written like a value'); // what is shown, 39 digits, is
  });

  it('names the same delimiter whichever one lies past 40 characters', () => {
    const answers = [';', '|', '\t'].map((d) => errorText(() => check('.csv', `${'a'.repeat(45)}${d}b\nT1\n`, { columns: { transaction_id: 'x', amount: 'y' } })));
    expect(new Set(answers).size).toBe(1);
  });
});

describe('time and memory on long names', () => {
  it('cuts two JSON keys of 6 million characters that begin alike without reading them whole', () => {
    // Review round 24: shownNames cut colliding names in the middle with an array entry per character: 2.8 GB, 7 s.
    const key = (end: string) => `${'k'.repeat(40)}${end.repeat(6_000_000)}`;
    const file = `[{"${key('a')}":1,"${key('b')}":2}]`;
    const started = performance.now();
    expect(errorText(() => check('.json', file, { columns: { transaction_id: 'id', amount: 'amt' } }))).toMatch(/^COLUMN_NOT_FOUND: /);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 30_000);

  it('judges the currency hint on a JSON key of 6 million characters in bounded time', () => {
    // Review round 24: split into words whole, four times, a key of 11 million characters took 6 s and 2.5 GB.
    const file = `[{"id":"T1","amt":5,"currency_${'aB1'.repeat(2_000_000)}":"GBP"},{"id":"T1","amt":-5}]`;
    const started = performance.now();
    expect(check('.json', file, { columns: { transaction_id: 'id', amount: 'amt' } }).summary).toContain('looks like a currency');
    expect(performance.now() - started).toBeLessThan(3000);
  }, 30_000);
});
