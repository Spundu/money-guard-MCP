import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

// Start the server over stdio, as an MCP host does, on the demo project in fixtures/shop.
const server = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env: {
    ...getDefaultEnvironment(),
    MONEY_GUARD_ROOT: fileURLToPath(new URL('../fixtures/shop', import.meta.url)),
    // The demo log's TEST key, public on purpose. Real keys live in the server's environment.
    MONEY_GUARD_AUDIT_KEYS: `k1=${'6b'.repeat(32)}`,
  },
});
// Speak MCP 2026-07-28, as Claude Code does. The server answers 2025-era clients too.
const client = new Client({ name: 'demo', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(server);

for (const [tool, args] of [
  ['money_lint_schema', { migrations: 'db/migrations' }],
  ['money_check_double_entry', { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'currency' } }],
  ['audit_verify_chain', { file: 'logs/audit-tampered.jsonl' }],
  ['money_check_double_entry', { file: '../../package.json', columns: { transaction_id: 'id', amount: 'amount' } }],
]) {
  const result = await client.callTool({ name: tool, arguments: args });
  console.log(`${tool}:\n  ${result.isError ? result.content[0].text : result.structuredContent.summary}`);
}
await client.close();
