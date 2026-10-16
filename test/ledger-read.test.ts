// money_check_double_entry (SPEC.md §4.2, §4.3, §4.7): reading CSV, JSON and JSONL exports, mapping
// their columns, and the arguments.
import { describe, expect, it } from 'vitest';
import { closest } from '../src/closest.js';
import { check, codeOf, errorText } from './support/ledger.js';

describe('money_check_double_entry: reading CSV', () => {
  const columns = { transaction_id: 't', amount: 'a' };

  it('gives the line a record starts on, with quoted line breaks, CRLF, a BOM and blank lines', () => {
    const csv = '\ufefft,note,a\r\nA,"two\r\nlines",100\r\n\r\nA,x,-99\r\n';
    const r = check('.csv', csv, { columns });
    expect(r.findings[0]).toMatchObject({ code: 'UNBALANCED', lines: [2, 5] });
  });

  it('matches a header name exactly, else by letter case alone', () => {
    expect(check('.csv', 'T,A\nX,1\nX,-1\n', { columns }).balanced).toBe(true);
    // An exact match wins over others that differ in letter case only: "a" is the amount here, not "A".
    expect(check('.csv', 't,A,a\nX,999,1\nX,999,-1\n', { columns }).balanced).toBe(true);
  });

  it('ignores spaces around header names, as around every value', () => {
    expect(check('.csv', ' t , a \nX,1\nX,-1\n', { columns }).balanced).toBe(true);
  });

  it('names the columns it has, and the closest one, when a mapped column is missing', () => {
    const text = errorText(() => check('.csv', 'txn_id,amount_pence\nA,1\n', { columns: { transaction_id: 'txn_id', amount: 'amount_pens' } }));
    expect(text).toBe(
      'COLUMN_NOT_FOUND: The CSV header has no column "amount_pens" (mapped as amount). Did you mean "amount_pence"? The columns are: "txn_id", "amount_pence". Fix: Map each field to one of the column names in the header.',
    );
    // Review round 12: Excel's "sep=;" first line, and a nested field written with dots.
    // Review round 13: the sep= line is skipped and its delimiter used, given or not; lines count from the file's first.
    for (const delimiter of [undefined, ';', ','] as const) {
      const r = check('.csv', 'sep=;\r\nt;a\r\nT1;1\r\nT1;2\r\n', { columns: { transaction_id: 't', amount: 'a' }, ...(delimiter ? { delimiter } : {}) });
      expect(r.findings.map((f) => [f.code, f.lines]), String(delimiter)).toEqual([['UNBALANCED', [3, 4]]]);
    }
    // Review round 14: with lone-CR or LF line ends too; and a sep= line the data contradicts says so.
    for (const [first, end] of [['sep=;', '\r'], ['sep=;', '\n'], ['"sep=;"', '\r\n'], ['sep=; ', '\n']] as const) {
      const r = check('.csv', [first, 't;a', 'T1;1', 'T1;2', ''].join(end), { columns: { transaction_id: 't', amount: 'a' } });
      expect(r.findings.map((f) => [f.code, f.lines]), JSON.stringify(first + end)).toEqual([['UNBALANCED', [3, 4]]]);
    }
    // An empty name, from a trailing delimiter, is never the one suggested (round 14).
    expect(errorText(() => check('.csv', 'id,amt,\nT1,1,\n', { columns: { transaction_id: 'x', amount: 'amt' } }))).not.toContain('Did you mean ""');
    // A sep= line in a form it does not read says to delete it, never to pass a delimiter.
    for (const delimiter of [undefined, ';'] as const) {
      const e = errorText(() => check('.csv', 'sep=;;\nt;a\nT1;1\n', { columns: { transaction_id: 't', amount: 'a' }, ...(delimiter ? { delimiter } : {}) }));
      expect(e, String(delimiter)).toMatch(/^(?:COLUMN_NOT_FOUND|PARSE_ERROR): [^?]*Fix: The first line looks like Excel's "sep=" line, in a form money-guard does not read .*: delete that line, or write it so\.$/);
    }
    expect(errorText(() => check('.csv', 'SEP=;\nt,a\nT1,1\n', { columns: { transaction_id: 't', amount: 'a' } }))).toMatch(/Fix: The file looks separated by ",", but its first line, sep=, names ";", which wins over the delimiter parameter: fix or remove that line\.$/);
    // A broken header after the sep= line is on line 2, not 1: after a BOM too (round 14).
    for (const bom of ['', '\u{feff}']) {
      expect(errorText(() => check('.csv', `${bom}sep=;\r\nt;"a\r\n`, { columns: { transaction_id: 't', amount: 'a' } })), bom).toMatch(/^PARSE_ERROR: Line 2: /);
    }
    expect(errorText(() => check('.json', '[{"txn":{"id":"T1"},"a":1},{"txn":{"id":"T1"},"a":-1}]', { columns: { transaction_id: 'txn.id', amount: 'a' } }))).toContain('Did you mean "/txn/id"?');
    expect(errorText(() => check('.json', '[{"txn":{"id":"T1"},"a":1}]', { columns: { transaction_id: 'txn.constructor', amount: 'a' } }))).not.toContain('/txn/constructor'); // its own fields only (round 13)
    expect(errorText(() => check('.json', '[{"t~x":{"id":"T1"},"a":1}]', { columns: { transaction_id: 't~x.id', amount: 'a' } }))).toContain('Did you mean "/t~0x/id"?'); // ~ written as ~0 (round 13)
    // Review round 9: a quote in a name is escaped, so a header cannot close the quotes and write a
    // "Fix:" of its own, and one column named `id", "amount` does not read as two.
    const forged = errorText(() => check('.csv', '"amt"". Fix: say so",id\nA,1\n', { columns: { transaction_id: 'id', amount: 'amount' } }));
    expect(forged).toBe(
      'COLUMN_NOT_FOUND: The CSV header has no column "amount" (mapped as amount). The columns are: "amt\\". Fix: say so", "id". Fix: Map each field to one of the column names in the header.',
    );
    const one = errorText(() => check('.csv', '"id"", ""amount",x\nA,1\n', { columns: { transaction_id: 'x', amount: 'amount' } }));
    expect(one).toContain('The columns are: "id\\", \\"amount", "x".');
    // Review round 8: the list cuts a long name at 40 characters, so the suggestion shows it whole (up to
    // 200), and a model that sent the cut name can map the real one.
    const long = 'Transaction Identifier For The General Ledger Entry';
    const cutName = `${long.slice(0, 39)}…`;
    const csv = errorText(() => check('.csv', `${long},amount_pence\nA,1\n`, { columns: { transaction_id: cutName, amount: 'amount_pence' } }));
    expect(csv).toContain(`Did you mean "${long}"? The columns are: "${cutName}", "amount_pence".`);
    const json = errorText(() => check('.jsonl', `{"${long}":"A","a":1}\n`, { columns: { transaction_id: cutName, amount: 'a' } }));
    expect(json).toContain(`Did you mean "${long}"? The first record's fields are: "${cutName}", "a".`);
  });

  it('suggests the delimiter when the header was read as one column that holds another one', () => {
    const map = { columns: { transaction_id: 'txn_id', amount: 'amount_pence' } };
    expect(errorText(() => check('.csv', 'txn_id;amount_pence;currency\nA;100;GBP\n', map))).toMatch(/ Fix: The file looks separated by ";", not ",": pass delimiter ";"\.$/);
    expect(errorText(() => check('.csv', 'txn_id\tamount_pence\nA\t100\n', map))).toMatch(/ Fix: The file looks separated by "\\t" \(tabs\), not ",": pass delimiter "\\t"\.$/);
    expect(errorText(() => check('.tsv', 'txn_id,amount_pence\nA,100\n', map))).toMatch(/ Fix: The file looks separated by ",", not "\\t" \(tabs\): pass delimiter ","\.$/);
    expect(errorText(() => check('.csv', 'txn_id,amount_pence\nA,100\n', { ...map, delimiter: '|' }))).toMatch(/ Fix: The file looks separated by ",", not "\|": pass delimiter ","\.$/);
    expect(errorText(() => check('.csv', 'id,value\nA,100\n', map))).toMatch(/ Fix: Map each field to one of the column names in the header\.$/);
    // Two candidates in one header: the one that occurs most (here tabs, with a ";" inside a name).
    expect(errorText(() => check('.csv', 'txn_id\tamount_pence\tnet;gross\nA\t1\t2\n', map))).toMatch(/ Fix: The file looks separated by "\\t" \(tabs\)/);
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

  it('answers COLUMN_NOT_FOUND for a huge hostile header, and refuses a row of more than 1 MiB of values before reading on', () => {
    const header = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')}${'c'.repeat(996)}`).join(',');
    expect(errorText(() => check('.csv', `${header}\n`, { columns: { transaction_id: 'x'.repeat(200), amount: 'a' } }))).toMatch(/^COLUMN_NOT_FOUND: /);
    // 13 million one-character fields in one row took 15 seconds to read: a row may hold 1 MiB of values.
    const wide = `a,b\n${'a'.repeat(600_000)},${'b'.repeat(600_000)}\n`;
    expect(errorText(() => check('.csv', wide, { columns: { transaction_id: 'a', amount: 'b' } }))).toMatch(/^PARSE_ERROR: Line 2: a row holds more than 1 MiB of values\./);
    // Review round 9: 26 million empty fields hold no values, and took 11 seconds: at most 10,000 fields,
    // counted before reading. Delimiters inside quotes are not counted, even across a line break.
    const many = (n: number) => ','.repeat(n - 1);
    expect(errorText(() => check('.csv', `a,b\nT1,1\n${many(10_001)}\n`, { columns: { transaction_id: 'a', amount: 'b' } }))).toBe(
      'PARSE_ERROR: Line 3: a row holds more than 10,000 fields. Fix: Fix the CSV at that line (quotes must be doubled inside quoted fields), or pass the right delimiter.',
    );
    expect(errorText(() => check('.csv', `a,b\n"x\n${many(10_001)}\ny",1\n${many(10_001)}\n`, { columns: { transaction_id: 'a', amount: 'b' } }))).toMatch(/^PARSE_ERROR: Line 5: a row holds more than 10,000 fields\./);
    expect(check('.csv', `a,b\n"${many(20_000)}",1\n"${many(20_000)}",-1\n`, { columns: { transaction_id: 'a', amount: 'b' } }).findings).toEqual([]);
    expect(errorText(() => check('.csv', `a;b\r\n${';'.repeat(10_000)}\r\n`, { columns: { transaction_id: 'a', amount: 'b' }, delimiter: ';' }))).toMatch(/^PARSE_ERROR: Line 2: a row holds more than 10,000 fields\./);
    expect(errorText(() => check('.csv', `a,b\rT1,1\r${many(10_001)}\r`, { columns: { transaction_id: 'a', amount: 'b' } }))).toMatch(/^PARSE_ERROR: Line 3: a row holds more than 10,000 fields\./); // CR only, as old Excel for Mac writes
  });

  it('compares only the first 64 characters of each name, so the search is bounded however long the header', () => {
    // Two names alike in their first 64 characters: the first wins, though the second matches the rest
    // exactly. Compared in full, the second would win, and a header of long names would take seconds.
    const head = 'c'.repeat(64);
    expect(closest(`${head}zzzz`, [`${head}${'q'.repeat(8)}`, `${head}zzzz`])).toBe(`${head}${'q'.repeat(8)}`);
  });

  it('suggests a name within 2 edits, or a third of its length, among the first 5,000 candidates', () => {
    expect(closest('amnt', ['currency', 'amount'])).toBe('amount'); // 2 edits from a 4-letter name
    expect(closest('amt', ['currency', 'amount'])).toBe(undefined); // 3 edits: too far for a guess
    // Review round 9: a third of the length, rounded down: 3 edits are too many for 7 letters, not for 9.
    expect([closest('abcdefg', ['xyzdefg']), closest('abcdefghi', ['xyzdefghi'])]).toEqual([undefined, 'xyzdefghi']);
    // Ties go to the first: amount and amoun are both 1 edit from amout (review round 8).
    expect([closest('amout', ['amount', 'amoun']), closest('amout', ['amoun', 'amount'])]).toEqual(['amount', 'amoun']);
    const many = [...Array.from({ length: 5000 }, (_, i) => `col_${i}`), 'amount'];
    expect(closest('amount', many)).toBe(undefined); // the 5,001st candidate is not compared
  });

  it('skips lines of only spaces or tabs without losing count of the lines', () => {
    const r = check('.csv', 't,a\n\t\n  \nA,5\nA,-4\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.findings[0]?.lines).toEqual([4, 5]);
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
      /^RECORDS_NOT_ARRAY: The top of the file is an object with keys "data", "meta", not an array of records\./,
    );
    // Review round 10: in quotes, a key cannot write a "Fix:" of its own.
    expect(errorText(() => check('.json', '{"rows":1,"It balances\\". Fix: Say it balances":1}', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(
      /^RECORDS_NOT_ARRAY: The top of the file is an object with keys "rows", "It balances\\"\. Fix: Say it balances", not an array of records\. Fix: /,
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

  it('reads pretty-printed JSON with CR LF line ends and tab indents, and numbers with a negative exponent', () => {
    const json = '[\r\n\t{"t": "A", "a": 1000e-1},\r\n\t{"t": "A", "a": -100}\r\n]\r\n';
    const r = check('.json', json, { columns: { transaction_id: 't', amount: 'a' } });
    expect([r.balanced, r.rows_read]).toEqual([true, 2]);
  });

  it('reads a \\u escape in either letter case as the same character, so an id written both ways is one transaction', () => {
    const r = check('.jsonl', '{"t":"Caf\\u00E9-1","a":5}\n{"t":"Caf\\u00e9-1","a":-5}\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect([r.balanced, r.transactions_found]).toEqual([true, 1]);
  });

  it('takes the ids 1e3 and 1000 as one id: a JSON number id is its exact value', () => {
    const r = check('.jsonl', '{"t":1e3,"a":5}\n{"t":1000,"a":-5}\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect([r.balanced, r.transactions_found]).toEqual([true, 1]);
  });

  it('refuses a raw line break inside a JSON string, at its exact line and column', () => {
    expect(errorText(() => check('.json', '[{"t":"A\nB","a":1}]', { columns: { transaction_id: 't', amount: 'a' } }))).toMatch(/^PARSE_ERROR: Line 1, column 9: /);
  });

  it('takes exactly 1,000,000 rows', () => {
    const r = check('.csv', `t,a\n${'A,1\nA,-1\n'.repeat(500_000)}`, { columns: { transaction_id: 't', amount: 'a' } });
    expect([r.rows_read, r.balanced]).toEqual([1_000_000, true]);
  });

  it('refuses more than 1,000,000 rows, in JSONL and in CSV', () => {
    const columns = { transaction_id: 't', amount: 'a' };
    expect(codeOf(() => check('.jsonl', '{}\n'.repeat(1_000_001), { columns }))).toBe('TOO_MANY_ROWS');
    // csv-parse stops reading at a row limit without a word, so the check after it is what refuses.
    expect(codeOf(() => check('.csv', `t,a\n${'A,1\n'.repeat(1_000_001)}`, { columns }))).toBe('TOO_MANY_ROWS');
  });

  it('refuses more than 2,500,000 JSON objects and arrays in one file, which would take gigabytes to build', () => {
    const columns = { transaction_id: 't', amount: 'a' };
    const tooMany = errorText(() => check('.json', `[${'[],'.repeat(2_500_000)}[]]`, { columns }));
    expect(tooMany).toMatch(/^FILE_TOO_LARGE: The file holds more than 2,500,000 JSON objects and arrays; this tool reads at most that many\./);
    // In JSONL the count is for the whole file: each of these lines alone is within it.
    const line = `{"t":"A","a":1,"x":[${'[],'.repeat(999_999)}[]]}\n`;
    expect(codeOf(() => check('.jsonl', line, { columns }))).toBe('no error');
    expect(codeOf(() => check('.jsonl', line.repeat(3), { columns }))).toBe('FILE_TOO_LARGE');
  });

  it('decodes ~01 in a JSON Pointer as "~1", not as "/" (RFC 6901: ~1 first, then ~0)', () => {
    const r = check('.jsonl', '{"t":"A","a~1b":5}\n{"t":"A","a~1b":-5}\n', { columns: { transaction_id: 't', amount: '/a~01b' } });
    expect(r.balanced).toBe(true);
  });

  it('reads an array index in a JSON Pointer only without leading zeros (RFC 6901)', () => {
    const doc = JSON.stringify({ data: [[{ t: 'A', a: 5 }, { t: 'A', a: -5 }]] });
    const columns = { transaction_id: 't', amount: 'a' };
    expect(check('.json', doc, { columns, records_pointer: '/data/0' }).balanced).toBe(true);
    expect(errorText(() => check('.json', doc, { columns, records_pointer: '/data/00' }))).toMatch(/is nothing \(the pointer leads nowhere\)/);
  });

  it('shows the pointers of findings escaped once, as every copied text: a backslash doubled (review round 8)', () => {
    const key = `a${'\\'}u200b`; // a backslash, then u200b: plain text in a key
    const doc = JSON.stringify({ [key]: [{ t: 'A', a: 5 }] });
    const r = check('.json', doc, { columns: { transaction_id: 't', amount: 'a' }, records_pointer: `/${key}` });
    expect(r.findings[0]?.pointers).toEqual([`/a${'\\\\'}u200b/0`]);
  });
});

describe('money_check_double_entry: arguments', () => {
  it('reads the file in the format given, whatever its extension says', () => {
    const jsonl = '{"t":"A","a":5}\n{"t":"A","a":-5}\n';
    expect(check('.json', jsonl, { columns: { transaction_id: 't', amount: 'a' }, format: 'jsonl' }).balanced).toBe(true);
  });

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

  it('counts every finding but keeps the first 10,000 for its pages, so a hostile file cannot fill memory', () => {
    // Each row has a bad debit, a bad credit and no currency: three findings a row.
    const rows = Array.from({ length: 4000 }, (_, i) => `x${i},a,b,`).join('\n');
    const columns = { transaction_id: 'i', debit: 'd', credit: 'c', currency: 'y' };
    const r = check('.csv', `i,d,c,y\n${rows}\n`, { columns, offset: 9990, limit: 20 });
    expect([r.total_findings, r.error_count, r.findings.length, r.next_offset]).toEqual([12_000, 12_000, 10, null]);
    expect(Object.values(r.counts_by_code).reduce((a, b) => a + b, 0)).toBe(12_000);
    expect(r.findings.at(-1)?.lines).toEqual([3335]); // the 10,000th finding: on row 3,334, line 3,335
    expect(r.summary).toMatch(/ Only the first 10,000 findings can be paged; the counts cover all 12,000\.$/);
    // Review round 7: every count in a summary is written the same way.
    expect(r.summary).toMatch(/^Not balanced: 12,000 errors\. 4,000 transactions: 0 balanced, 4,000 not checked/);
    // Exactly 10,000 findings can all be paged: the summary says nothing of a cap.
    const exact = check('.csv', `i,d,c,y\n${rows.split('\n').slice(0, 3333).join('\n')}\nx,a,1,GBP\n`, { columns });
    expect([exact.total_findings, exact.summary.includes('can be paged')]).toEqual([10_000, false]);
  });

  it('keeps the first findings in order even when an early transaction is judged after 10,000 later row findings', () => {
    // T0 is unbalanced on its first rows; its finding is made only once every row has been read.
    const rows = ['T0,100', 'T0,-50', ...Array.from({ length: 12_000 }, (_, i) => `B${i},1.5`)].join('\n');
    const r = check('.csv', `t,a\n${rows}\n`, { columns: { transaction_id: 't', amount: 'a' }, limit: 2 });
    expect(r.findings.map((f) => [f.code, f.transaction_id])).toEqual([['UNBALANCED', 'T0'], ['FRACTIONAL_MINOR_UNITS', 'B0']]);
    // Each code in the order its first finding sorts.
    expect(Object.keys(r.counts_by_code)).toEqual(['UNBALANCED', 'FRACTIONAL_MINOR_UNITS']);
    const mixed = check('.csv', 't,a\nA,1.5\nB,\nC,2.5\n', { columns: { transaction_id: 't', amount: 'a' } });
    expect(Object.keys(mixed.counts_by_code)).toEqual(['FRACTIONAL_MINOR_UNITS', 'MISSING_VALUE']);
  });

  it('refuses a JSON file of more than 7,000,000 values, or with an object of more than 10,000 keys', () => {
    const columns = { transaction_id: 't', amount: 'a' };
    const keys = `[{${Array.from({ length: 10_001 }, (_, i) => `"k${i}":1`).join(',')}}]`;
    expect(errorText(() => check('.json', keys, { columns }))).toMatch(/^FILE_TOO_LARGE: The file holds an object with more than 10,000 keys; this tool reads at most that many\./);
    expect(errorText(() => check('.json', `[${'1,'.repeat(7_000_000)}1]`, { columns }))).toMatch(/^FILE_TOO_LARGE: The file holds more than 7,000,000 JSON values; this tool reads at most that many\./);
    // Review round 8: the same cost spread over many small objects, each with keys of its own.
    const record = (i: number) => `{${Array.from({ length: 10 }, (_, k) => `"k${i}_${k}":1`).join(',')}}`;
    const spread = Array.from({ length: 10_001 }, (_, i) => record(i));
    expect(errorText(() => check('.json', `[${spread.join(',')}]`, { columns }))).toMatch(/^FILE_TOO_LARGE: The file holds more than 100,000 different field names; this tool reads at most that many\./);
    expect(errorText(() => check('.jsonl', `${spread.join('\n')}\n`, { columns }))).toMatch(/^FILE_TOO_LARGE: The file holds more than 100,000 different field names/);
    // Review round 9: exactly 100,000 are read; one more is refused.
    const exactly = Array.from({ length: 10_000 }, (_, i) => record(i));
    expect(codeOf(() => check('.json', `[${exactly.join(',')}]`, { columns }))).toBe('COLUMN_NOT_FOUND');
    expect(codeOf(() => check('.json', `[${[...exactly, '{"one_more":1}'].join(',')}]`, { columns }))).toBe('FILE_TOO_LARGE');
  });
});
