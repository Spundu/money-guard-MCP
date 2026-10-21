// The oracle for the eval's cases: calls money-guard itself, with the right arguments, on every test
// project and fails unless it reports exactly the planted problems, so every case is findable with
// the tools and the clean projects come back clean. No model, no API key. CI runs it.
// Run after `npm run build` and `node eval/build_cases.mjs`: node eval/check_cases.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const cases = JSON.parse(readFileSync(at('./cases.json'), 'utf8'));

const lint = (migrations) => ['money_lint_schema', { migrations }];
const ledger = (file, transaction_id, amount, currency) =>
  ['money_check_double_entry', { file, columns: { transaction_id, amount, ...(currency ? { currency } : {}) } }];
const audit = (file) => ['audit_verify_chain', { file }];

/** The calls a careful agent would make on each case. */
const ORACLE = {
  'schema-float': [lint('db/migrations')],
  'schema-money-type': [lint('migrations')],
  'schema-alter-later': [lint('db/migrations')],
  'schema-clean': [lint('db/migrations')],
  'schema-numeric': [lint('sql')],
  'schema-dbmate': [lint('db/migrations')],
  'ledger-unbalanced': [ledger('exports/journal.csv', 'txn_id', 'amount_pence')],
  'ledger-clean': [ledger('exports/journal.csv', 'txn_id', 'amount_pence')],
  'ledger-json-fraction': [['money_check_double_entry', { file: 'data/ledger.json', records_pointer: '/data', columns: { transaction_id: 'tx', amount: 'amount_cents' } }]],
  'ledger-odd-headers': [ledger('exports/bank-2026-09.csv', 'Txn Ref', 'Ccy Amt', 'Ccy')],
  'ledger-currency': [ledger('exports/fx.jsonl', 'id', 'amount_minor', 'currency')],
  'audit-tampered': [audit('logs/audit.jsonl')],
  'audit-intact': [audit('logs/audit.jsonl')],
  'mixed-ship': [lint('db/migrations'), ledger('exports/journal.csv', 'txn_id', 'amount_pence')],
  'mixed-clean': [lint('db/migrations'), ledger('exports/ledger.csv', 'txn_id', 'amount_pence'), audit('logs/audit.jsonl')],
  'mixed-vague': [lint('db/migrations'), ledger('exports/transfers.jsonl', 'transfer', 'pence')],
};

/** The planted problems one result reports, written as the cases write them. */
function reported(tool, result) {
  const s = result.structuredContent;
  if (tool === 'money_lint_schema') return s.findings.map((f) => `${f.table.replace(/^public\./, '')}.${f.column}`);
  if (tool === 'money_check_double_entry') return s.findings.map((f) => `txn:${f.transaction_id}`);
  return s.ok ? [] : [`${s.file.split('/').pop()}#${s.break.entry_index}`];
}

let failures = 0;
for (const c of cases) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [at('../dist/index.js')],
    env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: at(`./cases/${c.id}`), MONEY_GUARD_AUDIT_KEYS: `k1=${'6b'.repeat(32)}` },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'eval-oracle', version: '1.0.0' });
  await client.connect(transport);
  console.log(`\n== ${c.id}  expected: ${c.expected.join('; ') || 'none'}`);
  const found = new Set();
  for (const [tool, args] of ORACLE[c.id]) {
    const r = await client.callTool({ name: tool, arguments: args });
    console.log(`  ${tool}: ${r.isError ? 'ERROR ' + r.content[0].text : r.structuredContent.summary}`);
    if (!r.isError) for (const item of reported(tool, r)) found.add(item);
  }
  await client.close();
  const want = [...c.expected].sort().join('; ');
  const got = [...found].sort().join('; ');
  if (want !== got) {
    failures++;
    console.log(`  MISMATCH: money-guard reports ${got || 'nothing'}`);
  }
}
if (failures) {
  console.error(`\n${failures} case(s) where money-guard's own answer differs from the planted problems`);
  process.exitCode = 1;
} else console.log(`\nAll ${cases.length} cases: money-guard reports exactly the planted problems.`);
