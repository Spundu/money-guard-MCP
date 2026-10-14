// money_lint_schema's fix_sql (SPEC.md §3.6): conversions that keep stored amounts right, run on real rows;
// none where a default, a CHECK or an index condition would keep the old unit; names quoted as
// PostgreSQL quotes them, whatever a migration does to the database's own functions.
import { describe, expect, it } from 'vitest';
import { NULL_FIX_NOTE, holdsNoAmount, isZeroOrNullDefault } from '../src/lint/catalog.js';
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
      'ALTER TABLE public.o ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN discount TYPE bigint USING round(discount * 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN refund TYPE bigint USING (refund::numeric * 100)::bigint;',
      'ALTER TABLE public.o ALTER COLUMN fee_pence TYPE bigint USING round(fee_pence)::bigint;', // minor units already: the default keeps its meaning
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
      'ALTER TABLE public.t ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;',
      'ALTER TABLE public.t ALTER COLUMN fee TYPE bigint USING round(fee * 100)::bigint;',
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
      ['public.charges', 'ALTER TABLE public.charges ALTER COLUMN amount TYPE bigint USING round(amount * 100)::bigint;'], // a zero default and a check of zero: fine
      ['public.fees', null],
      ['public.payments', null],
      ['public.payouts', null],
      ['public.rents', 'ALTER TABLE public.rents ALTER COLUMN amount TYPE bigint USING round(amount * 100)::bigint;'],
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
    ];
    for (const expr of safe) expect(holdsNoAmount(expr), expr).toBe(true);
    const amounts = ['((fee > (0)::numeric) AND (fee <= 99.99))', '(cap <= max_total())', '(amount <= (1000)::numeric)', '(round(amount) = amount)', '(amount > (100)::numeric(10,2))', "(code <> '840'::text)"];
    for (const expr of amounts) expect(holdsNoAmount(expr), expr).toBe(false);
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

  it('knows a zero or NULL default, however PostgreSQL writes it back, and nothing else', () => {
    for (const zero of ['0', '0.00', '0.0', "'0'::numeric", '(0)::numeric', "'0'::double precision", 'NULL::numeric', '-0.00']) expect(isZeroOrNullDefault(zero), zero).toBe(true);
    for (const other of ['2.50', "'1.50'::money", '(1 - 1)', '0.01', "'0x'::text", 'now()', "''"]) expect(isZeroOrNullDefault(other), other).toBe(false);
  });

  it('writes fix_sql itself, quoting every name: a migration that redefines quote_ident cannot change it', async () => {
    const r = await lint({
      'db/migrations/0001.sql':
        'create table "user" (total double precision, "q""price" double precision);\n' +
        "create or replace function pg_catalog.quote_ident(text) returns text language sql as $$ select 'x; DROP TABLE users; --' $$;\n",
    });
    expect(r.findings.map((f) => f.fix_sql)).toEqual([
      'ALTER TABLE public."user" ALTER COLUMN "q""price" TYPE bigint USING round("q""price" * 100)::bigint;',
      'ALTER TABLE public."user" ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;',
    ]);
    // The statements run as written: a keyword and a double quote are quoted as PostgreSQL quotes them.
    const created = 'create table "user" (total double precision, "q""price" double precision); insert into "user" values (1.5, 2.25);';
    expect(await sql([created, ...r.findings.map((f) => f.fix_sql ?? 'fix_sql missing')], 'select total::text, "q""price"::text as q from "user"')).toEqual([{ total: '150', q: '225' }]);
  });

  it('quotes every keyword quote_ident quotes, not only the fully reserved ones', async () => {
    // "left" may name a function or a type but not a column: written bare, the fix would not run.
    const table = 'create table t ("left" double precision, "between" double precision);';
    const r = await lint({ 'db/migrations/0001.sql': table }, { money_columns: ['t.left', 't.between'] });
    const fixes = r.findings.map((f) => f.fix_sql ?? 'fix_sql missing');
    expect(fixes).toEqual([
      'ALTER TABLE public.t ALTER COLUMN "between" TYPE bigint USING round("between" * 100)::bigint;',
      'ALTER TABLE public.t ALTER COLUMN "left" TYPE bigint USING round("left" * 100)::bigint;',
    ]);
    await expect(sql([table, ...fixes])).resolves.toEqual([{ ok: 1 }]);
  });
});
