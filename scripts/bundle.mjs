// Builds the Claude Desktop bundle, money-guard-mcp-<version>.mcpb in the repository root, then tests
// it the way Claude Desktop starts it. Run it with `npm run bundle`.
//
// The bundle holds what `npm install money-guard-mcp` installs: the packed tarball (the package's own
// files allowlist) with its production dependencies only, plus mcpb/manifest.json and the licence.
// The test unpacks the bundle into an empty folder, fills in the settings a user would choose (the
// demo project, and its public test key), starts the server with the manifest's own command, args and
// env, and calls each tool. It also checks that no development files went in.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOP = path.join(REPO, 'fixtures', 'shop');
const TEST_KEYS = `k1=${'6b'.repeat(32)}`; // fixtures/shop's published TEST key (scripts/fixtures.mts)

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this with `npm run bundle`, so it uses the npm that started it.');
const run = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const npm = (args, cwd) => run([npmCli, ...args], cwd);
// The mcpb CLI, pinned, fetched by npm when a bundle is built (as CI fetches the Inspector). It is kept
// out of devDependencies: its signing and prompt libraries would bring npm audit warnings to everyone
// who only installs to run the tests, and the bundle uses only validate, pack and unpack.
const MCPB = '@anthropic-ai/mcpb@2.1.2';
const mcpb = (args) => npm(['exec', '--yes', `--package=${MCPB}`, '--', 'mcpb', ...args], REPO);

const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const out = path.join(REPO, `${pkg.name}-${pkg.version}.mcpb`);
const work = mkdtempSync(path.join(tmpdir(), 'money-guard-bundle-'));
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

try {
  // Build. `npm pack` runs prepare, which builds dist/ from the current source. A dependency's
  // devDependencies are never installed, so installing the tarball brings production dependencies only.
  npm(['pack', '--pack-destination', work], REPO);
  const staging = path.join(work, 'bundle');
  mkdirSync(staging);
  writeFileSync(path.join(staging, 'package.json'), '{ "private": true }\n');
  npm(['install', path.join(work, `${pkg.name}-${pkg.version}.tgz`), '--no-audit', '--no-fund', '--no-bin-links', '--no-package-lock'], staging);
  rmSync(path.join(staging, 'package.json')); // the install's own, not part of the bundle
  copyFileSync(path.join(REPO, 'mcpb', 'manifest.json'), path.join(staging, 'manifest.json'));
  copyFileSync(path.join(REPO, 'LICENSE'), path.join(staging, 'LICENSE'));
  mcpb(['validate', path.join(staging, 'manifest.json')]);
  mcpb(['pack', staging, out]);
  console.log(`built ${path.basename(out)}`);

  // Test what was packed, from an empty folder.
  const dir = path.join(work, 'unpacked');
  mcpb(['unpack', out, dir]);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const installed = path.join(dir, 'node_modules', pkg.name);
  check(manifest.version === pkg.version && JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version === pkg.version, `manifest and server are version ${pkg.version}`);
  check(readdirSync(installed).sort().join() === 'LICENSE,README.md,dist,package.json', 'the server package holds only dist/, LICENSE, README.md and package.json');
  for (const dev of ['typescript', 'vitest', '@modelcontextprotocol/client', '@anthropic-ai/mcpb']) {
    check(!existsSync(path.join(dir, 'node_modules', ...dev.split('/'))), `no development package ${dev}`);
  }

  /** The server as Claude Desktop starts it: the manifest's command, args and env, with the settings filled in. */
  const start = async (settings) => {
    const fill = (text) =>
      text.replaceAll('${__dirname}', dir).replace(/\$\{user_config\.(\w+)\}/g, (whole, key) => settings[key] ?? manifest.user_config[key]?.default ?? whole);
    const { command, args, env } = manifest.server.mcp_config;
    const transport = new StdioClientTransport({
      command: command === 'node' ? process.execPath : command, // Claude Desktop runs "node" with its built-in Node.js
      args: args.map(fill),
      env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])) },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'bundle-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(transport);
    return client;
  };

  const client = await start({ project_folder: SHOP, audit_keys: TEST_KEYS });
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    check(names.join() === manifest.tools.map((t) => t.name).join(), `the server's tools are the manifest's: ${names.join(', ')}`);
    const lint = await client.callTool({ name: 'money_lint_schema', arguments: { migrations: 'db/migrations' } });
    check(lint.structuredContent?.error_count === 1, 'money_lint_schema finds the float money column');
    const ledger = await client.callTool({ name: 'money_check_double_entry', arguments: { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence' } } });
    check(ledger.structuredContent?.balanced === false, 'money_check_double_entry finds the unbalanced transaction');
    const audit = await client.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit-tampered.jsonl' } });
    check(audit.structuredContent?.break?.code === 'CONTENT_TAMPERED', 'audit_verify_chain finds the edited entry');
  } finally {
    await client.close();
  }

  // The keys left blank, as most users will: the field's default makes the variable empty, not a placeholder.
  const blank = await start({ project_folder: SHOP });
  try {
    const audit = await blank.callTool({ name: 'audit_verify_chain', arguments: { file: 'logs/audit.jsonl' } });
    check(audit.isError === true && /^KEYS_NOT_CONFIGURED: No HMAC keys are configured/.test(audit.content?.[0]?.text ?? ''), 'with the keys left blank, the audit tool says none are configured');
  } finally {
    await blank.close();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`bundle test FAILED: ${failures.length} check(s)`);
  process.exit(1);
}
console.log(`bundle test OK: ${path.basename(out)}`);
