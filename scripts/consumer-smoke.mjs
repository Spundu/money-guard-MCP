// Copied into a fresh project where the PACKED tarball and the MCP client are installed, and run there
// (see .github/workflows/ci.yml), so that it imports them, not the repository's own packages: starts
// the installed server the way an MCP host does, over stdio, and checks the published package works
// on its own, with no repository files except the demo project.
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const pkgDir = path.dirname(require.resolve('money-guard-mcp/package.json'));
const pkg = require('money-guard-mcp/package.json');
const shop = path.join(process.env.GITHUB_WORKSPACE ?? path.resolve('..'), 'fixtures', 'shop');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pkgDir, pkg.bin['money-guard-mcp'])],
  env: { ...getDefaultEnvironment(), MONEY_GUARD_ROOT: shop },
});
const client = new Client({ name: 'consumer-smoke', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(transport);
const era = client.getProtocolEra();
const tools = (await client.listTools()).tools.map((t) => t.name);
const lint = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
await client.close();

const summary = lint.structuredContent?.summary;
console.log({ version: pkg.version, era, tools, summary });
if (era !== 'modern' || tools.length !== 3 || summary !== '2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.') {
  console.error('consumer smoke test FAILED');
  process.exit(1);
}
