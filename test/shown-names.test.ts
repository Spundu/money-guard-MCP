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

  it('reads a JSONL file the same way, with the names of its first records', () => {
    const key = 'currency_code_as_reported_by_the_bank_of_issue';
    const jsonl = `{"id":"T1","money":{"value":5,"${key}":"GBP"}}\n{"id":"T1","money":{"value":-5,"${key}":"GBP"}}\n`;
    const mapped = check('.jsonl', jsonl, { columns: { transaction_id: 'id', amount: '/money/value', currency: `/money/${key.slice(0, 39)}…` } });
    expect(mapped.summary).toBe('Balanced: the 1 transaction nets to zero in whole minor units.');
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
