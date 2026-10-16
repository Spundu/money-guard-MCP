// money_lint_schema's fix_sql (SPEC.md §3.6): conversions that keep stored amounts right, run on real rows;
// none where a default, a CHECK or an index condition would keep the old unit; names quoted as
// PostgreSQL quotes them, whatever a migration does to the database's own functions.
import { describe, expect, it } from 'vitest';
import { ExpressionReader, MAX_LINT_EXPR_CHARS } from '../src/lint/amounts.js';
import { DETAIL_SQL, NULL_FIX_NOTE, holdsNoAmount, isZeroOrNullDefault } from '../src/lint/catalog.js';
import { moneyByGuess } from '../src/lint/names.js';
import { lint } from './support/lint.js';
import { sql } from './support/sql.js';

describe('money_lint_schema: fix_sql', () => {
  it('gives a fix_sql that converts the stored amounts correctly, and none where the unit needs a decision', async () => {
    const r = await lint({
      'db/migrations/0001.sql':
        'create table p (price double precision, amount_minor_units double precision, price_cents_usd double precision, ' +
        'fee numeric(10,2), total numeric, amount numeric(12,0), unit_price numeric(12,4), amount_pence numeric(10,1), refund money, charge smallint, deposit numeric(10,-2));',
    });
    const fix = Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]));
    // Finer than a penny (a tenth of one, in pence): choose the unit first.
    expect([fix.unit_price, fix.amount_pence]).toEqual([null, null]);
    // Review round 12: three places too (a tenth of a penny), not only four.
    expect((await lint({ 'db/migrations/0001.sql': 'create table q (price numeric(12,3));' })).findings[0]?.fix_sql).toBe(null);
    expect(r.fixes.NUMERIC_MONEY).toContain(NULL_FIX_NOTE.trim());
    expect(r.fixes.FLOAT_MONEY).not.toContain('Where fix_sql is null');
    // Run each fix on real rows: pounds become pence, minor units and whole numbers stay as they are.
    const columns = ['price', 'amount_minor_units', 'price_cents_usd', 'fee', 'total', 'amount', 'refund', 'charge', 'deposit'];
    const rows = await sql(
      [
        'create table p (price double precision, amount_minor_units double precision, price_cents_usd double precision, fee numeric(10,2), total numeric, amount numeric(12,0), refund money, charge smallint, deposit numeric(10,-2));' +
          "insert into p values (19.99, 1999, 1999, 12.34, 0.1, 1500, '-5.50', 550, 1500);",
        ...columns.map((column) => fix[column] ?? 'fix_sql missing'),
      ],
      `select ${columns.map((c) => `${c}::text`).join(', ')} from p`,
    );
    // deposit is numeric(10,-2): whole hundreds, kept as they are.
    expect(rows).toEqual([{ price: '1999', amount_minor_units: '1999', price_cents_usd: '1999', fee: '1234', total: '10', amount: '1500', refund: '-550', charge: '550', deposit: '1500' }]);
  });

  it('gives no fix_sql that would leave a default, a CHECK constraint, or a unique or exclusion index condition or expression in pounds', async () => {
    // ALTER COLUMN ... TYPE converts stored rows with USING, but a default of 2.50 would become 3 pence,
    // CHECK (amount_cap <= 1000.00) a cap of £10, and a unique index's condition would admit other rows,
    // with the next lint seeing nothing wrong.
    const r = await lint({
      'db/migrations/0001.sql':
        'create table o (id int, delivery_fee numeric(10,2) not null default 2.50, amount_cap numeric(10,2) check (amount_cap <= 1000.00), ' +
        "subtotal double precision, total double precision default 0, discount numeric(10,2) default null, refund money default 0, price money default '1.50', refund_typed money default 0::money, " +
        'refund_checked money check (refund_checked >= 0::money), ' +
        'fee_pence double precision default 2.5);\n' +
        'create unique index big_orders on o (id) where subtotal > 100;\n' +
        // An exclusion constraint's condition and a unique index's expression decide which rows may exist too.
        'create table bookings (room int, deposit numeric(10,2), exclude using btree (room with =) where (deposit > 100));\n' +
        'create table refunds (order_id int, refund_total numeric(10,2));\n' +
        'create unique index refunds_whole on refunds (order_id, (round(refund_total)));\n',
    });
    const fix = Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]));
    // refund_typed, refund_checked: a money value cannot work on a bigint, so those ALTERs would fail.
    expect([fix.delivery_fee, fix.amount_cap, fix.subtotal, fix.price, fix.refund_typed, fix.refund_checked]).toEqual([null, null, null, null, null, null]);
    expect([fix.deposit, fix.refund_total]).toEqual([null, null]);
    expect([fix.total, fix.discount, fix.refund, fix.fee_pence]).toEqual([
      'ALTER TABLE public.o ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN discount TYPE bigint USING pg_catalog.round(discount OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN refund TYPE bigint USING (refund::numeric OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN fee_pence TYPE bigint USING pg_catalog.round(fee_pence)::bigint;', // minor units already: the default keeps its meaning
    ]);
    for (const code of ['FLOAT_MONEY', 'NUMERIC_MONEY', 'MONEY_TYPE'] as const) expect(r.fixes[code]).toContain('a default, CHECK constraint or unique index condition that may hold amounts in the old unit');
  });

  it('offers fix_sql beside a CHECK that holds no amount and an ordinary index with a condition, and keeps them right', async () => {
    const schema =
      "create function max_total() returns numeric language sql immutable as 'select 1000';\n" +
      'create table t (id int, status text, total double precision check (total >= 0), fee numeric(10,2) check (fee is not null and fee <> 0), ' +
      'amount_cap numeric(10,2) check (amount_cap <= max_total()), net numeric(10,2), subtotal numeric(10,2), check (net >= subtotal));\n' +
      "create index t_open on t (total) where status = 'open';\n" +
      // An ordinary index's condition only decides which rows it speeds up: it may hold an amount.
      'create index t_big on t (fee) where fee > 100;\n';
    const r = await lint({ 'db/migrations/0001.sql': schema });
    const fix = Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]));
    expect([fix.amount_cap, fix.net, fix.subtotal]).toEqual([null, null, null]); // a function's result; a CHECK across two columns
    expect([fix.total, fix.fee]).toEqual([
      'ALTER TABLE public.t ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public.t ALTER COLUMN fee TYPE bigint USING pg_catalog.round(fee OPERATOR(pg_catalog.*) 100)::bigint;',
    ]);
    const fixed = [`${schema}insert into t (status, total, fee) values ('open', 19.99, 2.5);`, `${fix.total}\n${fix.fee}`];
    expect(await sql(fixed, 'select total::text, fee::text from t')).toEqual([{ total: '1999', fee: '250' }]);
    await expect(sql([...fixed, 'insert into t (total, fee) values (-1, 1);'])).rejects.toThrow(/violates check constraint/); // the checks still hold
  });

  it('weighs the defaults, CHECKs and unique indexes of partitions and inheritance children too, at any depth', async () => {
    // An ALTER of the parent changes the children's column; their own defaults and CHECKs stay in pounds.
    const r = await lint({
      'db/migrations/0001.sql': [
        'create table payments (id int, region text, amount numeric(10,2)) partition by list (region);',
        "create table payments_eu partition of payments (amount default 9.99) for values in ('eu');",
        // Two levels down: a partition of a partition.
        'create table payouts (id int, region text, kind text, amount numeric(10,2)) partition by list (region);',
        "create table payouts_eu partition of payouts for values in ('eu') partition by list (kind);",
        "create table payouts_eu_card partition of payouts_eu (amount default 9.99) for values in ('card');",
        'create table fees (amount numeric(10,2));',
        'create table child_fees (note text, check (amount < 50.00)) inherits (fees);',
        'create table charges (amount numeric(10,2));',
        'create table charges_old () inherits (charges);',
        'alter table charges_old alter column amount set default 0;',
        'alter table charges_old add check (amount >= 0);',
        // A child that declares the column again has it as its own too: reported, but changed only on the parent.
        'create table rents (amount numeric(10,2));',
        'create table rents_old (amount numeric(10,2)) inherits (rents);',
        // A unique index on a child, whose condition holds an amount.
        'create table tips (amount numeric(10,2));',
        'create table tips_old () inherits (tips);',
        'create unique index tips_old_big on tips_old (amount) where amount > 5;',
      ].join('\n'),
    });
    expect(r.findings.map((f) => [f.table, f.fix_sql])).toEqual([
      ['public.charges', 'ALTER TABLE public.charges ALTER COLUMN amount TYPE bigint USING pg_catalog.round(amount OPERATOR(pg_catalog.*) 100)::bigint;'], // a zero default and a check of zero: fine
      ['public.fees', null],
      ['public.payments', null],
      ['public.payouts', null],
      ['public.rents', 'ALTER TABLE public.rents ALTER COLUMN amount TYPE bigint USING pg_catalog.round(amount OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['public.rents_old', null],
      ['public.tips', null],
    ]);
  });

  it('tells a CHECK or an index condition that holds no amount from one that may', () => {
    const safe = [
      '(total >= (0)::double precision)', '((fee IS NOT NULL) AND (fee <> (0)::numeric))', '(amount > 0)',
      // review round 4: digits in a name or a type's size; two-decimal guards; a soft-delete condition
      '(q1_revenue >= (0)::numeric)', '("Q2 total" >= 0)', '(total >= (0)::numeric(10,2))', '(total = round(total, 2))',
      '(total = round((total)::numeric, 2))', '(scale(fee) <= 2)', '(deleted_at IS NULL)',
      // review round 5: trunc's places and "scale below 3" guard two decimals too; a text literal holds no amount
      '(total = trunc(total, 2))', '(scale(total) < 3)', "((total >= (0)::numeric) AND (note <> 'x\"y'::text))",
      // review round 9: a literal cast to a bounded type; more places than two
      "(total >= '0'::numeric(10,2))", '(total = round(total, 4))', '(scale(total) <= 12)',
      // review round 14: another column cast to a date, a time or a uuid, as a unique index may
      '(created_at)::date', '((created_at)::timestamp without time zone IS NOT NULL)', '((ref)::uuid IS NOT NULL)', '((paid)::boolean)',
      "((price >= (0)::double precision) AND (label <> 'a.*b'::text))", // ".*" inside a literal is not the whole row (round 13)
    ];
    for (const expr of safe) expect(holdsNoAmount(expr), expr).toBe(true);
    const amounts = ['((fee > (0)::numeric) AND (fee <= 99.99))', '(cap <= max_total())', '(amount <= (1000)::numeric)', '(round(amount) = amount)', '(amount > (100)::numeric(10,2))', "(code <> '840'::text)",
      // review round 5: a quote inside a text literal must not hide the amount after it; an amount in quotes
      "(((total)::text <> 'x\"'::text) AND (total < 500) AND ('\"'::text <> 'y'::text))", "(total <= '1000.00'::numeric)",
      // review round 8: a bigint has scale 0, so "scale = 2" fails for every pence value
      '(scale((price)::numeric) = 2)', '(scale(total) = 1)',
      // review round 9: a cast of the column to a bounded type is a cap; a guard of fewer than two places
      // stops guarding once the column holds pence
      '((price)::small_amt IS NOT NULL)', '((price)::public.small_amt IS NOT NULL)', // round 13: a domain can cap
      '((price)::money_cap IS NOT NULL)', '((price)::numeric_small IS NOT NULL)', // round 14: a domain whose name starts like a harmless type
      '((amount)::numeric(5,2) = amount)', '((amount)::smallint IS NOT NULL)', '(price = ((price)::bigint)::double precision)', '(fee = (fee)::int8)', '((amount)::integer = amount)', '(amount::int4 > 0)',
      '(amount = round(amount, 0))', '(amount = round(amount, 1))',
      // review round 11: the amount's text against a pattern
      "(((price)::text ~ '^-?\\d+\\.\\d\\d$'::text))", "((price)::text ~~ '%.__'::text)", "((price)::text ~~* '%.__'::text)", "((price)::text ~ similar_to_escape('[0-9]+'::text))", // as PostgreSQL writes LIKE, ILIKE, SIMILAR TO
      // review round 10: a text of fixed length is a cap too
      '(((fee)::character varying(5))::text = (fee)::text)', '((fee)::bpchar(4) IS NOT NULL)', '(scale(total) = 0)', '(scale(total) <= 0)', '(scale(total) <= 1)', '(scale(total) < 2)'];
    for (const expr of amounts) expect(holdsNoAmount(expr), expr).toBe(false);
    // Review round 10: past 2,000 characters a CHECK may hold anything, and is not read further.
    const near = `(amount > 0 OR ${'x'.repeat(1976)} IS NULL)`; // exactly 2,000 characters: still read (round 11)
    expect([near.length === 2000, holdsNoAmount(near), holdsNoAmount(`${near.slice(0, -1)} )`.padEnd(2001, ' '))]).toEqual([true, true, false]);
  });

  it('reads a long CHECK in time that grows with its length, not its square', async () => {
    // Review round 10: 120,000 characters with no "::" took 35 s on the server's main thread, where
    // neither the time limit nor a cancellation can stop it, and nothing else was answered meanwhile.
    const started = performance.now();
    const r = await lint({ 'db/migrations/0001.sql': `create table orders (id int, amount double precision check (amount > 0 or '${'a'.repeat(120_000)}' = 'x'));` });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(r.findings.map((f) => [f.column, f.fix_sql])).toEqual([['amount', null]]);
  });

  it('offers fix_sql beside a digit in a name or a type size, a two-decimal guard and a soft-delete index, and the fixes run', async () => {
    const schema =
      'create table s (product_id int, deleted_at timestamptz, q1_revenue numeric(10,2) check (q1_revenue >= 0), ' +
      'price numeric(12,2) check (price >= 0::numeric(10,2)), total numeric(12,2) check (total = round(total, 2)), ' +
      'fee numeric(12,2) check (scale(fee) <= 2), amount numeric(12,2));\n' +
      'create unique index s_live on s (product_id, amount) where deleted_at is null;\n';
    const r = await lint({ 'db/migrations/0001.sql': schema });
    const fixes = r.findings.map((f) => f.fix_sql);
    expect(fixes.length).toBe(5);
    expect(fixes.every((f) => f !== null)).toBe(true);
    const fixed = [`${schema}insert into s values (1, null, 10.50, 2.25, 3.10, 4.75, 5.00);`, ...fixes.map((f) => f ?? 'fix_sql missing')];
    expect(await sql(fixed, 'select q1_revenue::text, price::text, total::text, fee::text, amount::text from s')).toEqual([
      { q1_revenue: '1050', price: '225', total: '310', fee: '475', amount: '500' },
    ]);
    await expect(sql([...fixed, 'insert into s values (1, null, 1, 1, 1, 1, 500);'])).rejects.toThrow(/duplicate key/); // the index still holds
  });

  it(`reads each expression of a lint once, and at most ${MAX_LINT_EXPR_CHARS} characters in all`, () => {
    // Review round 12: 24,300 capped defaults from 80 inherited tables held the main thread 20 s.
    const reader = new ExpressionReader();
    const zero = `${'('.repeat(990)}0${')'.repeat(990)}`;
    // Only the reader is timed: 24,300 expect() calls took longer than it on a busy machine (round 13).
    const started = performance.now();
    let zeros = 0;
    for (let i = 0; i < 24_300; i += 1) if (reader.isZeroOrNullDefault(zero)) zeros += 1;
    const took = performance.now() - started;
    expect([zeros, took < 1000]).toEqual([24_300, true]);
    // Distinct texts past the budget count as holding an amount, so the fix is withheld.
    const distinct = (i: number) => `(amount >= 0 AND ${'x'.repeat(1900)}${i} IS NOT NULL)`;
    const answers = Array.from({ length: 600 }, (_, i) => reader.holdsNoAmount(distinct(i)));
    expect(answers.slice(0, 500).every((a) => a)).toBe(true);
    expect(answers.slice(-50).every((a) => !a)).toBe(true);
  });

  it('knows a zero or NULL default, however PostgreSQL writes it back, and nothing else', () => {
    for (const zero of ['0', '0.00', '0.0', "'0'::numeric", '(0)::numeric', "'0'::double precision", 'NULL::numeric', '-0.00',
      // review round 9: two casts, a plus sign, an exponent
      "('0'::numeric)::double precision", "'+0'::numeric", "'0e5'::numeric", "'0.0E-3'::numeric"]) expect(isZeroOrNullDefault(zero), zero).toBe(true);
    for (const other of ['2.50', "'1.50'::money", '(1 - 1)', '0.01', "'0x'::text", 'now()', "''", "('2.5'::numeric)::double precision", "'1e5'::numeric", "'0e'::numeric"]) {
      expect(isZeroOrNullDefault(other), other).toBe(false);
    }
    // Review round 11: each pass reads the whole text on the server's main thread; 2,000 nested casts
    // (134,000 characters) took 364 ms each. Past 2,000 characters a default counts as an amount, at once.
    const deep = `0${`::${'m'.repeat(63)}`.repeat(2000)}`;
    const started = performance.now();
    expect(isZeroOrNullDefault(deep)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500); // at once: 364 ms each before, and a busy runner may pause
  });

  it('writes fix_sql itself, quoting every name: a migration that redefines quote_ident cannot change it', async () => {
    const r = await lint({
      'db/migrations/0001.sql':
        'create table "user" (total double precision, "q""price" double precision);\n' +
        "create or replace function pg_catalog.quote_ident(text) returns text language sql as $$ select 'x; DROP TABLE users; --' $$;\n",
    });
    expect(r.findings.map((f) => f.fix_sql)).toEqual([
      'ALTER TABLE public."user" ALTER COLUMN "q""price" TYPE bigint USING pg_catalog.round("q""price" OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public."user" ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;',
    ]);
    // The statements run as written: a keyword and a double quote are quoted as PostgreSQL quotes them.
    const created = 'create table "user" (total double precision, "q""price" double precision); insert into "user" values (1.5, 2.25);';
    expect(await sql([created, ...r.findings.map((f) => f.fix_sql ?? 'fix_sql missing')], 'select total::text, "q""price"::text as q from "user"')).toEqual([{ total: '150', q: '225' }]);
  });

  it('gives no fix_sql beside a CHECK that reads the whole row, which PostgreSQL records as column 0', async () => {
    // Review round 11: such a CHECK was never matched to the column; the ALTER then left a cap of £1,000 at £10.
    const r = await lint({ 'db/migrations/0001.sql': "create table x (id int, price numeric(10,2), constraint wr check ((to_jsonb(x.*) ->> 'price')::numeric <= 1000));" });
    expect(r.findings.map((f) => [f.column, f.fix_sql])).toEqual([['price', null]]);
  });

  it('offers fix_sql beside a unique index of another column\'s expression, and withholds it beside one of the whole row', async () => {
    // Review round 12: lower(sku) also depends on the whole table, which round 11 read as the whole row.
    const r = await lint({ 'db/migrations/0001.sql': 'create table products (id int, sku text, price double precision);\ncreate unique index products_sku on products (lower(sku));\ncreate table rows_hashed (id int, price double precision);\ncreate unique index rows_whole on rows_hashed (id) where rows_hashed is not null;\ncreate table skus (sku text, price double precision);\ncreate unique index skus_a on skus (sku) where sku ~ \'^A.*\';\ncreate table q (id int, "it\'s" int, "o\'k" int, price double precision);\ncreate unique index q_whole on q (id) where "it\'s" is not null and q is not null and "o\'k" is not null;' });
    // Review round 13: ".*" inside a string literal is not the whole row. Round 14: an apostrophe in a
    // quoted name does not start a literal that hides the whole row after it.
    expect(r.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.products', false], ['public.q', true], ['public.rows_hashed', true], ['public.skus', false]]);
    expect(holdsNoAmount('(("it\'s" IS NOT NULL) AND (q.* IS NOT NULL) AND ("o\'k" IS NOT NULL))')).toBe(false);
    // Review round 15: an index condition that compares the amount with another number column would
    // compare pence with pounds; a plain key column, or another column cast to a date, would not.
    const other = await lint({ 'db/migrations/0001.sql': [
      'create table refunds (order_id int, approval_limit numeric(10,2), amount numeric(10,2));',
      'create unique index one_big_refund on refunds (order_id) where amount > approval_limit;',
      'create extension btree_gist;',
      'create table deposits (room int, min_deposit int, deposit double precision, exclude using gist (room with =) where (deposit > min_deposit));',
      'create table charges (user_id int, created_at timestamp, amount double precision);',
      'create unique index one_a_day on charges (user_id, amount, (created_at::date));',
    ].join('\n') });
    expect(other.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.charges', false], ['public.deposits', true], ['public.refunds', true]]);
    // Review round 16: a key column that the WHERE or an expression reads as well counts.
    const keyed = await lint({ 'db/migrations/0001.sql': [
      'create table k1 (approval_limit numeric(10,2), amount double precision);',
      'create unique index k1_u on k1 (approval_limit) where amount > approval_limit;',
      'create table k2 (id int, amount double precision, other int);',
      'create unique index k2_u on k2 (id, amount, other) where other > amount;',
      'create table k3 (other int, amount double precision);',
      'create unique index k3_u on k3 (other, (amount - other));',
      'create extension btree_gist;',
      'create table k4 (cap int, amount double precision, exclude using gist (cap with =) where (amount > cap));',
    ].join('\n') });
    expect(keyed.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.k1', true], ['public.k2', true], ['public.k3', true], ['public.k4', true]]);
    // Review round 16 (found by mutation): a condition on the money column alone keeps the fix.
    const own = await lint({ 'db/migrations/0001.sql': [
      'create table orders (customer_id int, amount double precision);',
      'create unique index orders_u on orders (customer_id) where amount > 0;',
      'create table subs (plan text, price numeric(10,2));',
      'create unique index subs_u on subs (plan) where price is not null;',
    ].join('\n') });
    expect(own.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.orders', false], ['public.subs', false]]);
    // Review round 16: a jsonb or an array column read by the condition can hold an amount too.
    const held = await lint({ 'db/migrations/0001.sql': [
      'create table j1 (id int, meta jsonb, amount double precision);',
      "create unique index j1_u on j1 (id) where amount > (meta->>'limit')::numeric;",
      'create table j2 (id int, limits numeric[], amount double precision);',
      'create unique index j2_u on j2 (id) where amount > all (limits);',
    ].join('\n') });
    expect(held.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.j1', true], ['public.j2', true]]);
  });

  it('reads a long unique-index condition once per index, not once per column', async () => {
    // Review round 14: 1,000 terms over 1,000 columns, read per column and per pg_depend row, ran the
    // database thread out of memory (or past 120 s with the whole row as well).
    const cols = Array.from({ length: 1000 }, (_, i) => `c${i} text`).join(', ');
    const terms = Array.from({ length: 1000 }, (_, i) => `c${i} is not null`).join(' and ');
    const schema = `create table w (${cols}, price double precision);\ncreate unique index w_u on w (c0) where ${terms} and w is not null;`;
    const r = await lint({ 'db/migrations/0001.sql': schema }, { timeout_seconds: 30 });
    expect([r.findings.length, r.findings[0]?.fix_sql]).toEqual([1, null]); // past 2,000 characters: may hold an amount
    // Each column gets the index's text once, cut to the stand-in: 1,001 columns, not 24 MB of copies.
    const rows = (await sql([schema], DETAIL_SQL)) as Array<{ index_exprs: string[] | null }>;
    const texts = rows.flatMap((row) => row.index_exprs ?? []);
    expect([texts.length, Math.max(...texts.map((t) => t.length))]).toEqual([1001, 2001]);
    // Review round 16: defaults too, each text once a column, through a chain of inheriting tables.
    const chain = [`create table c0 (price double precision default (0 + ${'0 + '.repeat(600)}0));`, ...Array.from({ length: 40 }, (_, i) => `create table c${i + 1} () inherits (c${i});`)];
    const inherited = (await sql(chain, DETAIL_SQL)) as Array<{ defaults: string[] | null }>;
    expect(inherited.map((row) => row.defaults)).toEqual([['x'.repeat(2001)]]);
  }, 60_000);

  it('calls only pg_catalog\'s round and *, so an operator a migration planted in the real database never runs', async () => {
    // Review round 11 (CVE-2018-1058): public.* (double precision, integer) matches exactly and is picked
    // over pg_catalog's, running as whoever applies the fix. Both kinds of fix, and the money type's.
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (price double precision, amount_pence double precision, refund money);' });
    const fixes = r.findings.map((f) => f.fix_sql ?? 'fix_sql missing');
    const planted = [
      'create table t (price double precision, amount_pence double precision, refund money); insert into t values (1.5, 2.25, 3.5);',
      'create table ran (what text);',
      "create function public.evil_times(a double precision, b integer) returns double precision language plpgsql as $$ begin insert into ran values ('*'); return a * 7; end $$;",
      'create operator public.* (leftarg = double precision, rightarg = integer, function = public.evil_times);',
      "create function public.evil_numeric(a numeric, b integer) returns numeric language plpgsql as $$ begin insert into ran values ('numeric *'); return a * 7; end $$;",
      'create operator public.* (leftarg = numeric, rightarg = integer, function = public.evil_numeric);',
      "create function public.round(a double precision) returns double precision language plpgsql as $$ begin insert into ran values ('round'); return 7; end $$;",
    ];
    expect(await sql([...planted, ...fixes], "select (select count(*) from ran)::text as ran, price::text, amount_pence::text, refund::text from t")).toEqual([
      { ran: '0', price: '150', amount_pence: '2', refund: '350' },
    ]);
  });

  it('gives no fix_sql where "minor" or "sat" may not name the unit: price_sat may be Saturday\'s price', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (price_sat double precision, price_mon double precision, amount_minor_units double precision);' });
    expect(Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]))).toEqual({
      amount_minor_units: 'ALTER TABLE public.t ALTER COLUMN amount_minor_units TYPE bigint USING pg_catalog.round(amount_minor_units)::bigint;',
      price_mon: 'ALTER TABLE public.t ALTER COLUMN price_mon TYPE bigint USING pg_catalog.round(price_mon OPERATOR(pg_catalog.*) 100)::bigint;',
      price_sat: null,
    });
  });

  it('gives no fix_sql for a name holding a backslash before "u": in the SQL it would read as an escape', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t ("price_\\u202e_total" double precision, total double precision);' });
    expect(r.findings.map((f) => [f.column, f.fix_sql === null])).toEqual([
      ['price_\\\\u202e_total', true],
      ['total', false],
    ]);
  });

  it('quotes every keyword quote_ident quotes, not only the fully reserved ones', async () => {
    // "left" may name a function or a type but not a column: written bare, the fix would not run.
    const table = 'create table t ("left" double precision, "between" double precision);';
    const r = await lint({ 'db/migrations/0001.sql': table }, { money_columns: ['t.left', 't.between'] });
    const fixes = r.findings.map((f) => f.fix_sql ?? 'fix_sql missing');
    expect(fixes).toEqual([
      'ALTER TABLE public.t ALTER COLUMN "between" TYPE bigint USING pg_catalog.round("between" OPERATOR(pg_catalog.*) 100)::bigint;',
      'ALTER TABLE public.t ALTER COLUMN "left" TYPE bigint USING pg_catalog.round("left" OPERATOR(pg_catalog.*) 100)::bigint;',
    ]);
    await expect(sql([table, ...fixes])).resolves.toEqual([{ ok: 1 }]);
  });

  it('multiplies no name that is money only by a guess, unless money_columns lists it', async () => {
    // Review round 9: total_passengers and total_paid look alike to the name rule; a ×100 of a count
    // would be wrong, so a guessed name gets no conversion. Widening a smallint is still safe.
    const table = 'create table t (total_passengers double precision, total_paid double precision, net_ytd smallint);';
    const r = await lint({ 'db/migrations/0001.sql': table });
    expect(Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]))).toEqual({
      total_passengers: null,
      total_paid: 'ALTER TABLE public.t ALTER COLUMN total_paid TYPE bigint USING pg_catalog.round(total_paid OPERATOR(pg_catalog.*) 100)::bigint;',
      net_ytd: 'ALTER TABLE public.t ALTER COLUMN net_ytd TYPE bigint;',
    });
    expect(r.fixes.FLOAT_MONEY).toContain('a name that may not be money (total_passengers: if it is, list it in money_columns)');
    // Review round 10: the example the note gives must itself be a guess (total_mileage became a measure).
    const example = /a name that may not be money \((\w+):/.exec(r.fixes.FLOAT_MONEY ?? '')?.[1] ?? '';
    expect([example, moneyByGuess(example)]).toEqual(['total_passengers', true]);
    const listed = await lint({ 'db/migrations/0001.sql': table }, { money_columns: ['t.total_passengers'] });
    expect(listed.findings.find((f) => f.column === 'total_passengers')?.fix_sql).toBe(
      'ALTER TABLE public.t ALTER COLUMN total_passengers TYPE bigint USING pg_catalog.round(total_passengers OPERATOR(pg_catalog.*) 100)::bigint;',
    );
  });
});
