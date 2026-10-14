// mcpb/manifest.json must describe the same server as package.json and SPEC.md, so the Claude Desktop
// bundle cannot drift from the npm package. `npm run bundle` (scripts/bundle.mjs, run in CI) builds the
// bundle and starts it the way Claude Desktop does.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (file: string) => JSON.parse(readFileSync(path.join(REPO, file), 'utf8'));
const pkg = read('package.json');
const manifest = read('mcpb/manifest.json');

describe('mcpb/manifest.json', () => {
  it('has the package name, version and Node.js range', () => {
    expect([manifest.name, manifest.version, manifest.compatibility.runtimes.node]).toEqual([pkg.name, pkg.version, pkg.engines.node]);
  });

  it("starts the installed package's own bin", () => {
    const entry = `node_modules/${pkg.name}/${pkg.bin[pkg.name]}`;
    expect(manifest.server).toEqual({ type: 'node', entry_point: entry, mcp_config: expect.objectContaining({ command: 'node', args: [`\${__dirname}/${entry}`] }) });
  });

  it("lists the server's tools in the server's order (SPEC.md §2.7)", () => {
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(['money_lint_schema', 'money_check_double_entry', 'audit_verify_chain']);
  });

  it('passes the chosen folder and the keys as the settings; a blank key field becomes empty, not a placeholder', () => {
    expect(manifest.server.mcp_config.env).toEqual({ MONEY_GUARD_ROOT: '${user_config.project_folder}', MONEY_GUARD_AUDIT_KEYS: '${user_config.audit_keys}' });
    expect(manifest.user_config.project_folder).toMatchObject({ type: 'directory', required: true });
    expect(manifest.user_config.audit_keys).toMatchObject({ type: 'string', sensitive: true, required: false, default: '' });
  });
});
