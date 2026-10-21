// Writes the eval's test projects to eval/cases/<id>/ and the case list to eval/cases.json.
// Every planted problem is listed in `expected`; `decoys` are things a careless reviewer might flag
// but that are not money problems (a VAT rate, a weight). Run: node eval/build_cases.mjs
// The audit logs are sealed with the published TEST key of scripts/fixtures.mts (never use it for
// anything real), so the eval and the demo share one key.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryKeyProvider, appendEntry, toJsonlLine } from 'sealed-audit-chain';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(HERE, 'cases');
export const FIXTURE_KEY_HEX = '6b'.repeat(32);

/** A sealed audit log of `n` refund events; `edit` changes entry `edit` after sealing. */
function auditLog(n, edit) {
  const keys = new InMemoryKeyProvider({ k1: Buffer.from(FIXTURE_KEY_HEX, 'hex') }, 'k1');
  const lines = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    prev = appendEntry(prev, { event: 'payment.refund', order: `O${100 + i}`, amount_pence: 500 + i * 100 }, keys);
    lines.push(toJsonlLine(prev));
  }
  if (edit !== undefined) lines[edit] = lines[edit].replace(/"amount_pence":\d+/, '"amount_pence":99999');
  return lines.join('');
}

const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';

const CHECK = 'Check this project for money problems and tell me exactly what to fix.';

/** id, tags (first = the tool the case is about), prompt, files, expected, decoys. */
const cases = [
  {
    id: 'schema-float', tags: ['schema', 'positive'], prompt: CHECK,
    files: {
      'db/migrations/001_init.sql':
        'create table invoices (\n  id bigserial primary key,\n  total float8 not null,\n  vat_rate numeric(5,4) not null,\n  amount_paid_pence bigint not null default 0\n);\n',
    },
    expected: ['invoices.total'], decoys: ['invoices.vat_rate'],
  },
  {
    id: 'schema-money-type', tags: ['schema', 'positive'], prompt: 'Are my database migrations storing prices safely?',
    files: {
      'migrations/0001_products.sql':
        'create table products (\n  id serial primary key,\n  name text not null,\n  price money not null,\n  weight_kg real\n);\n',
    },
    expected: ['products.price'], decoys: ['products.weight_kg'],
  },
  {
    id: 'schema-alter-later', tags: ['schema', 'positive'], prompt: CHECK,
    files: {
      'db/migrations/001_payments.sql': 'create table payments (id bigserial primary key, amount_pence bigint not null);\n',
      'db/migrations/002_widen.sql': 'alter table payments alter column amount_pence type double precision;\n',
    },
    expected: ['payments.amount_pence'], decoys: [],
  },
  {
    id: 'schema-clean', tags: ['schema', 'negative'], prompt: CHECK,
    files: {
      'db/migrations/001_init.sql':
        'create table orders (\n  id bigserial primary key,\n  subtotal_pence bigint not null,\n  tax_rate numeric(5,4) not null,\n  total_pence bigint not null\n);\n',
      'db/migrations/002_refunds.sql': 'create table refunds (id bigserial primary key, order_id bigint references orders(id), amount_pence bigint not null);\n',
    },
    expected: [], decoys: ['orders.tax_rate'],
  },
  {
    id: 'schema-numeric', tags: ['schema', 'positive'], prompt: 'Review my migrations: do any money columns need changing?',
    files: {
      'sql/001_refunds.sql': 'create table refunds (id bigserial primary key, refund_amount numeric, reason text);\n',
      'sql/002_fees.sql': 'create table fees (id bigserial primary key, fee numeric(10,2) not null, exchange_rate numeric(12,6) not null);\n',
    },
    expected: ['refunds.refund_amount', 'fees.fee'], decoys: ['fees.exchange_rate'],
  },
  {
    id: 'schema-dbmate', tags: ['schema', 'positive'], prompt: CHECK,
    files: {
      'db/migrations/20260101120000_subscriptions.sql':
        '-- migrate:up\ncreate table subscriptions (id bigserial primary key, plan text not null, monthly_price real not null);\n\n-- migrate:down\ndrop table subscriptions;\n',
    },
    expected: ['subscriptions.monthly_price'], decoys: [],
  },
  {
    id: 'ledger-unbalanced', tags: ['ledger', 'positive'], prompt: 'Does the ledger export in exports/ balance?',
    files: {
      'exports/journal.csv': csv([
        ['txn_id', 'account', 'amount_pence'],
        ['J100', 'cash', '2500'], ['J100', 'sales', '-2500'],
        ['J101', 'cash', '1999'], ['J101', 'sales', '-1900'],
        ['J102', 'bank', '-4200'], ['J102', 'fees', '4200'],
      ]),
    },
    expected: ['txn:J101'], decoys: ['txn:J100', 'txn:J102'],
  },
  {
    id: 'ledger-clean', tags: ['ledger', 'negative'], prompt: 'Does the ledger export in exports/ balance?',
    files: {
      'exports/journal.csv': csv([
        ['txn_id', 'account', 'amount_pence'],
        ['J200', 'cash', '1200'], ['J200', 'sales', '-1000'], ['J200', 'vat', '-200'],
        ['J201', 'bank', '-750'], ['J201', 'fees', '750'],
      ]),
    },
    expected: [], decoys: ['txn:J200', 'txn:J201'],
  },
  {
    id: 'ledger-json-fraction', tags: ['ledger', 'positive'], prompt: 'Check data/ledger.json for money problems.',
    files: {
      'data/ledger.json': JSON.stringify({
        exported_at: '2026-10-01',
        data: [
          { tx: 'P1', account: 'cash', amount_cents: 1250 }, { tx: 'P1', account: 'sales', amount_cents: -1250 },
          { tx: 'P2', account: 'cash', amount_cents: 10.5 }, { tx: 'P2', account: 'sales', amount_cents: -10.5 },
        ],
      }, null, 2) + '\n',
    },
    expected: ['txn:P2'], decoys: ['txn:P1'],
  },
  {
    id: 'ledger-odd-headers', tags: ['ledger', 'positive'], prompt: 'Is the bank export in exports/ balanced?',
    files: {
      'exports/bank-2026-09.csv': csv([
        ['Txn Ref', 'Acct', 'Ccy Amt', 'Ccy'],
        ['T6', 'cash', '5000', 'GBP'], ['T6', 'sales', '-5000', 'GBP'],
        ['T7', 'cash', '1234', 'GBP'], ['T7', 'sales', '-1243', 'GBP'],
      ]),
    },
    expected: ['txn:T7'], decoys: ['txn:T6'],
  },
  {
    id: 'ledger-currency', tags: ['ledger', 'positive'], prompt: CHECK,
    files: {
      'exports/fx.jsonl': [
        { id: 'X1', account: 'cash_gbp', amount_minor: 1000, currency: 'GBP' },
        { id: 'X1', account: 'cash_eur', amount_minor: -1000, currency: 'EUR' },
        { id: 'X2', account: 'cash', amount_minor: 300, currency: 'GBP' },
        { id: 'X2', account: 'sales', amount_minor: -300, currency: 'GBP' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    },
    expected: ['txn:X1'], decoys: ['txn:X2'],
  },
  {
    id: 'audit-tampered', tags: ['audit', 'positive'], prompt: 'Has anyone edited our audit log in logs/?',
    files: { 'logs/audit.jsonl': auditLog(5, 2) },
    expected: ['audit.jsonl#2'], decoys: [],
  },
  {
    id: 'audit-intact', tags: ['audit', 'negative'], prompt: 'Has anyone edited our audit log in logs/?',
    files: { 'logs/audit.jsonl': auditLog(5) },
    expected: [], decoys: [],
  },
  {
    id: 'mixed-ship', tags: ['mixed', 'positive'],
    prompt: "I'm about to ship this project. Check its database migrations and the ledger export in exports/ for money problems, and tell me exactly what to fix.",
    files: {
      'db/migrations/001_init.sql':
        'create table customers (id bigserial primary key, name text not null);\ncreate table invoices (\n  id bigserial primary key,\n  customer_id bigint references customers(id),\n  total float8 not null,\n  vat_rate numeric(5,4) not null,\n  amount_paid_pence bigint not null default 0\n);\n',
      'db/migrations/002_refunds.sql': 'create table refunds (id bigserial primary key, invoice_id bigint references invoices(id), refund_amount numeric, reason text);\n',
      'exports/journal.csv': csv([
        ['txn_id', 'account', 'amount_pence'],
        ['J100', 'cash', '2500'], ['J100', 'sales', '-2500'],
        ['J101', 'cash', '1999'], ['J101', 'sales', '-1900'],
        ['J102', 'bank', '-4200'], ['J102', 'fees', '4200'],
      ]),
    },
    expected: ['invoices.total', 'refunds.refund_amount', 'txn:J101'], decoys: ['invoices.vat_rate'],
  },
  {
    id: 'mixed-clean', tags: ['mixed', 'negative'], prompt: 'Before I launch: is there anything wrong with how this app handles money?',
    files: {
      'db/migrations/001_init.sql': 'create table orders (id bigserial primary key, total_pence bigint not null, discount_rate numeric(5,4) not null default 0);\n',
      'exports/ledger.csv': csv([['txn_id', 'account', 'amount_pence'], ['L1', 'cash', '900'], ['L1', 'sales', '-900']]),
      'logs/audit.jsonl': auditLog(3),
    },
    expected: [], decoys: ['orders.discount_rate', 'txn:L1'],
  },
  {
    id: 'mixed-vague', tags: ['mixed', 'positive'], prompt: 'Before I launch: is there anything wrong with how this app handles money?',
    files: {
      'db/migrations/001_wallets.sql': 'create table wallets (id bigserial primary key, owner text not null, balance double precision not null default 0);\n',
      'exports/transfers.jsonl': [
        { transfer: 'W1', account: 'wallet:alice', pence: -500 }, { transfer: 'W1', account: 'wallet:bob', pence: 500 },
        { transfer: 'W2', account: 'wallet:bob', pence: -250 }, { transfer: 'W2', account: 'wallet:carol', pence: 205 },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    },
    expected: ['wallets.balance', 'txn:W2'], decoys: ['txn:W1'],
  },
];

rmSync(CASES, { recursive: true, force: true });
for (const c of cases) {
  for (const [rel, content] of Object.entries(c.files)) {
    const full = path.join(CASES, c.id, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}
const list = cases.map(({ files, ...c }) => ({ ...c, files: Object.keys(files) }));
writeFileSync(path.join(HERE, 'cases.json'), JSON.stringify(list, null, 2) + '\n');
console.log(`${cases.length} cases written to ${CASES}`);
