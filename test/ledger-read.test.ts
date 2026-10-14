// money_check_double_entry (SPEC.md §4.2, §4.3, §4.7): reading CSV, JSON and JSONL exports, mapping
// their columns, and the arguments.
import { describe, expect, it } from 'vitest';
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
  });

  it('ignores spaces around header names, as around every value', () => {
    expect(check('.csv', ' t , a \nX,1\nX,-1\n', { columns }).balanced).toBe(true);
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

  it('refuses more than 1,000,000 rows, in JSONL and in CSV', () => {
    const columns = { transaction_id: 't', amount: 'a' };
    expect(codeOf(() => check('.jsonl', '{}\n'.repeat(1_000_001), { columns }))).toBe('TOO_MANY_ROWS');
    // csv-parse stops reading at a row limit without a word, so the check after it is what refuses.
    expect(codeOf(() => check('.csv', `t,a\n${'A,1\n'.repeat(1_000_001)}`, { columns }))).toBe('TOO_MANY_ROWS');
  });

  it('decodes ~01 in a JSON Pointer as "~1", not as "/" (RFC 6901: ~1 first, then ~0)', () => {
    const r = check('.jsonl', '{"t":"A","a~1b":5}\n{"t":"A","a~1b":-5}\n', { columns: { transaction_id: 't', amount: '/a~01b' } });
    expect(r.balanced).toBe(true);
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
});
