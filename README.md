# money-guard-mcp

An MCP server that checks how a project handles money, for AI coding agents such as Claude Code. It is
read-only and offline: it never edits files, never connects to a database and never uses the network.

| Tool | What it checks |
|---|---|
| `money_lint_schema` | Runs your SQL migrations in a throwaway in-memory PostgreSQL 18 ([PGlite](https://pglite.dev)) and reads the real column types. Money stored as `real`/`double precision` or Postgres's `money` type is an error; `numeric` and `smallint` are warnings. Each finding names the migration that introduced it and gives the `ALTER` to fix it. |
| `money_check_double_entry` | Reads a ledger export (CSV, JSON or JSONL) and proves every transaction's legs net to zero per currency, in whole minor units, with exact integer maths. Every problem comes with its line number. |
| `audit_verify_chain` | Verifies an audit log written with [sealed-audit-chain](https://github.com/Spundu/audit-chain) byte for byte: the first edited, reordered, forged or missing entry, and why. The HMAC keys stay in the server's settings. |

**Status:** built and tested (protocol 2026-07-28 and the 2025 era, Node 22, 24 and 26, Linux and
Windows); not yet published on npm. The exact behaviour of every tool, every code and every limit is
in [SPEC.md](SPEC.md).

## Run it from a clone

```bash
git clone https://github.com/Spundu/money-guard-mcp.git
cd money-guard-mcp
npm ci            # installs and builds dist/
claude mcp add --transport stdio money-guard -- node /path/to/money-guard-mcp/dist/index.js
```

Claude Code gives the server your project folder (`CLAUDE_PROJECT_DIR`); every path a tool takes is
relative to it. To verify audit logs, set `MONEY_GUARD_AUDIT_KEYS` (`id=hex` pairs) in the server's
environment, never in the chat. Other clients set the folder with `MONEY_GUARD_ROOT`.

Try it on the demo project in [fixtures/shop](fixtures/shop): a migration that stores an order total as
a float, a ledger export with an unbalanced transaction and fractional pennies, and a sealed audit log
with a tampered copy.

## Security

- **stdio only.** There is no network listener, and no shell or child process. Migrations run in
  WebAssembly with a virtual filesystem, so they cannot reach your files.
- **Paths are confined to the project folder.** Links are followed and their real target is checked.
  `.env` files, private keys and `.git` are refused.
- Anything copied from a file into a result is cut to 40 characters. Keys never appear in a result, an
  error or a log line.
- **Time limits.** An endless migration is stopped at the time limit, and a stuck database is caught
  after 5 seconds.

## Development

```bash
npm run typecheck && npm run lint && npm test && npm run build
bash scripts/inspector-smoke.sh   # the official MCP Inspector, both protocol eras
```

MIT licence.
