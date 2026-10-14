# money-guard-mcp

[![CI](https://github.com/Spundu/money-guard-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Spundu/money-guard-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that lets an AI coding agent (Claude Code, or any MCP
client) check how a project handles money. It finds money stored as floats in SQL migrations, ledger
exports whose transactions do not balance, and audit logs that were edited after they were sealed.
Each answer names the exact file, column or line, and how to fix it.

It only reads files. It never edits anything, never connects to a database and never uses the
network.

**Status:** 0.1.0. Not on npm yet: run it from a clone (below). It speaks MCP 2026-07-28, and the 2025
protocol versions for older clients. [SPEC.md](SPEC.md) fixes every parameter, result field, code and
limit.

## What it checks

| Tool | What it does |
|---|---|
| `money_lint_schema` | Runs your SQL migrations, in order, in a throwaway in-memory PostgreSQL 18 ([PGlite](https://pglite.dev)), then reads the column types Postgres really built. Money stored as `real`/`double precision` (floats lose pennies) or in Postgres's `money` type is an error; `numeric` and `smallint` are warnings. Each finding names the migration that introduced it and, where the conversion is clear, gives an `ALTER TABLE` to start the fix. |
| `money_check_double_entry` | Reads a ledger export (CSV, JSON or JSONL) and checks that every transaction's legs net to zero in each currency, in whole minor units (pence, cents), with exact integer maths. Every problem comes with its line number (CSV, JSONL) or JSON Pointer (JSON). |
| `audit_verify_chain` | Verifies an audit log written with [sealed-audit-chain](https://github.com/Spundu/audit-chain), byte for byte: the first entry that was edited, reordered or forged, and why. Given the head of an earlier check, it also catches entries cut off the end. The HMAC keys stay in the server's settings; the agent never sees them. |

Why run the migrations instead of reading them? Patterns over SQL text easily miss a later `ALTER
COLUMN ... TYPE`, a domain, a rename or a comment. The catalog of a database that ran the migrations
does not.

## Quick start with Claude Code

You need Node.js 22.12 or newer, and git.

```sh
git clone https://github.com/Spundu/money-guard-mcp.git
cd money-guard-mcp
npm ci    # installs the dependencies, then builds dist/
```

Then, in your own project's folder, add the server to Claude Code:

```sh
claude mcp add --transport stdio money-guard -- node /path/to/money-guard-mcp/dist/index.js
```

On Windows, write the path with forward slashes: `C:/Users/you/money-guard-mcp/dist/index.js`.

Claude Code tells the server which project is open (`CLAUDE_PROJECT_DIR`), and every path the tools
take is relative to that folder. Then ask, for example:

- "Check our migrations for money stored as floats."
- "Does exports/ledger.csv balance? The transaction id is txn_id, the amounts are in amount_pence and the
  currency is in currency." (Without a currency column, every row counts as one currency.)
- "Verify logs/audit.jsonl."

The server tells Claude when each tool helps, to fix a schema finding with a new migration, and never
to repair an audit log that fails.

## Try it without an agent

[`examples/demo.mjs`](examples/demo.mjs) is a small MCP client. It starts the server the way an MCP
host does, then calls each tool on the demo project in [`fixtures/shop`](fixtures/shop). The demo has
an order total stored as a float, a ledger export with an unbalanced transaction and fractional
pennies, and an audit log that someone edited. The last call asks for a file outside the project.
From the clone, run `node examples/demo.mjs`:

```js
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
```

It prints this (the server also writes a startup line and one line per call to stderr):

```text
money_lint_schema:
  2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.
money_check_double_entry:
  Not balanced: 3 errors and 1 warning. 4 transactions: 2 balanced, 1 unbalanced, 1 not checked (rows with unreadable values).
audit_verify_chain:
  The log does NOT verify: entry 0 (line 1) was edited after it was sealed (CONTENT_TAMPERED).
money_check_double_entry:
  PATH_OUTSIDE_ROOT: "../../package.json" is outside the project folder (shop). Fix: Pass a path inside the project, relative to its root.
```

A problem the agent can fix comes back as a tool error whose text starts with a code, then says how
to fix it. (Arguments that break a tool's input schema come back as the SDK's own "Input validation
error", which has no code.)

## What the agent gets back

Every result is a JSON object whose first field is a one-sentence `summary`. The same JSON is also
sent as text, for clients that ignore structured results. This is `money_lint_schema` on the demo
project:

```json
{
  "summary": "2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.",
  "migrations": "db/migrations",
  "migrations_sha256": "0f1de47fa80f51572f92a14c692566220bcd6a11129e687d3900ea5adea7ac5d",
  "postgres": "PostgreSQL 18.6 (PGlite 0.5.9)",
  "files_applied_count": 3,
  "files_applied": [
    "db/migrations/0001_init.sql",
    "db/migrations/0002_fees.sql",
    "db/migrations/0003_payouts.sql"
  ],
  "files_applied_truncated": false,
  "tables_checked": 2,
  "money_columns_checked": 4,
  "error_count": 1,
  "warning_count": 1,
  "ignored_count": 0,
  "findings": [
    {
      "code": "FLOAT_MONEY",
      "severity": "error",
      "table": "public.orders",
      "column": "total",
      "type": "double precision",
      "introduced_in": "db/migrations/0001_init.sql",
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;"
    },
    {
      "code": "NUMERIC_MONEY",
      "severity": "warning",
      "table": "public.orders",
      "column": "platform_fee",
      "type": "numeric(10,2)",
      "introduced_in": "db/migrations/0002_fees.sql",
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING round(platform_fee * 100)::bigint;"
    }
  ],
  "findings_truncated": false,
  "other_float_columns": [],
  "other_float_columns_count": 0,
  "fixes": {
    "FLOAT_MONEY": "real and double precision are binary floating point: most decimal amounts (0.10, 19.99) cannot be stored exactly, and sums drift by fractions of a penny. Store integer minor units (pence, cents) in bigint: add a NEW migration with fix_sql and update the code that reads and writes the column. fix_sql takes the column to hold pounds or dollars and multiplies by 100, rounding to whole pence; when the name says the amounts are minor units already (pence, cents, minor), it only rounds. Renaming the column to <column>_pence makes the unit clear.",
    "NUMERIC_MONEY": "numeric is exact, so this is not a rounding bug, but amounts with decimals are not integer minor units: every piece of code must round the same way. Convert to bigint minor units, or pass accept_numeric: true if numeric is a deliberate choice. fix_sql multiplies by 100 for 2 decimal places, keeps whole numbers (scale 0) as they are, and rounds to whole pence where no scale is declared; if a scale-0 column holds whole pounds rather than pence, multiply by 100 instead."
  }
}
```

`fix_sql` is a starting point. It converts pounds to pence, keeps amounts that are already in pence
(or cents) as they are, and is `null` where the unit needs a decision, such as a column with four
decimal places; the tests run each kind of conversion on stored rows. The agent adds it as a new
migration and runs the check again, and the check runs that migration too. [SPEC.md](SPEC.md) shows
full results of the other two tools (§4.9, §5.8).

## Settings

| Environment variable | What it is | Default |
|---|---|---|
| `MONEY_GUARD_ROOT` | The project folder the tools may read. | `CLAUDE_PROJECT_DIR` (Claude Code sets it), else the working directory |
| `MONEY_GUARD_AUDIT_KEYS` | HMAC keys for `audit_verify_chain`: `id=hex` pairs separated by commas, each key at least 16 bytes (32 hex digits). | Not set: the audit tool says how to set it |

A bad setting does not stop the server. The tools that need it explain what is wrong, and the others
keep working.

To verify audit logs in Claude Code, keep the key in your shell's environment and pass it through a
project `.mcp.json` instead of the `claude mcp add` command above. Remove that first (`claude mcp
remove money-guard`): an entry added with the command takes precedence over the file's. The file holds
no secret, only a reference to the variable; its path to `dist/index.js` is the one on your machine:

```json
{
  "mcpServers": {
    "money-guard": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/money-guard-mcp/dist/index.js"],
      "env": { "MONEY_GUARD_AUDIT_KEYS": "${MONEY_GUARD_AUDIT_KEYS:-}" }
    }
  }
}
```

Never paste a key into the chat. The server does not need it there, and it never shows a key.

**Claude Desktop:** in the clone, `npm run bundle` builds `money-guard-mcp-0.1.0.mcpb` and tests it.
Open that file with Claude Desktop: double-click it, or use Settings → Extensions → Advanced settings
→ Install Extension. Choose the project folder. Add audit keys only if you verify audit logs; Claude
Desktop keeps them in the system keychain. The bundle passes the official `mcpb` validator, and CI
starts it the way its manifest says, but it has not yet been tried in Claude Desktop itself.

**Other MCP clients:** run `node /path/to/money-guard-mcp/dist/index.js` over stdio, with
`MONEY_GUARD_ROOT` set to the project folder.

## The tools in brief

**`money_lint_schema`**
- `migrations` (required): a folder of `.sql` files, or one `.sql` file such as a
  `pg_dump --schema-only` dump.
- The files run in natural order (`2_x` before `10_x`), at any depth. Files that only undo migrations
  (`down.sql`, `*.down.sql`, `*.undo.sql`, `*.rollback.sql`) are left out. In a file that holds both
  directions (dbmate, goose, sql-migrate, node-pg-migrate, tern), only the up part runs. `files` sets
  the order by hand (Flyway, sqitch).
- `preset: "supabase"` creates what Supabase provides (the `authenticated` role, `auth.users`,
  `auth.uid()`, the storage tables and more), so Supabase migrations run. `setup` runs your own SQL
  first.
- A column counts as money by its name (`price`, `amount_pence`, `totalMinor`, `platform_fee`,
  `price_per_month`, but not `price_id`, `tax_rate` or `total_count`), by the `money` type, or because
  you list it in `money_columns`. The rule and its word lists are in SPEC.md §3.5. Money kept in
  text or JSON columns is not checked, and the summary says how many such columns there are.
- Codes: `FLOAT_MONEY` and `MONEY_TYPE` are errors. `NUMERIC_MONEY` is a warning, which
  `accept_numeric: true` turns off. `SMALLINT_MONEY` is a warning (`smallint` holds at most £327.67 in
  pence).
- A migration that fails is reported with its file, line and column, the Postgres message and a hint.

**`money_check_double_entry`**
- `file` (required) and `columns` (required): `transaction_id`, plus either a signed `amount`, or an
  `amount` and a `side` (`D`/`C`), or `debit` and `credit`. `currency` is optional.
- Amounts are integer minor units by default. `amount_format: "decimal"` reads `12.34` as 1234, with
  `decimal_places` from 0 to 4.
- Codes: `UNBALANCED`, `TOO_FEW_LEGS`, `ZERO_LEG` (a warning), `MISSING_VALUE`, `BAD_AMOUNT`,
  `FRACTIONAL_MINOR_UNITS`, `AMOUNT_TOO_LARGE`, `BAD_SIDE`, `NEGATIVE_WITH_SIDE` and `BAD_ROW`.
- The findings come in pages (`offset`, `limit`).

**`audit_verify_chain`**
- `file` (required). Optionally `anchor` (`count` and `last_hash`): the `head` that an earlier
  successful run returned. With it, the tool also catches entries cut off the end, or a log that was
  replaced; entries added since are fine.
- It returns `ok`, the first broken entry with its line and a reason code (`CONTENT_TAMPERED`,
  `HMAC_MISMATCH`, `LINK_BROKEN` and others), and the `head` to keep for next time.

## Security

- **stdio only.** No network listener and no network requests. No shell and no child processes.
- **Migrations run in WebAssembly,** in a worker thread, with a virtual filesystem. They cannot read
  your files (`COPY ... FROM '/etc/hosts'` finds nothing) or run programs. An endless migration is
  stopped at the time limit (45 seconds by default), and a database left stuck is caught within 5
  seconds.
- **Paths are confined to the project folder.** Links are followed and their real target is checked.
  `..`, absolute paths outside the project, and Windows device and UNC paths are refused. Files that
  look like secrets (`.env`, private keys, `.npmrc`, anything in `.git`) are refused even inside the
  project.
- **Little is copied out of your files.** A value from a data file (a ledger cell, a header, an id) is
  cut to 40 characters. Table, column and file names stay whole, so the agent can act on them. In
  every result and error, control characters and the invisible characters that can make text read
  differently from what it is (the "Trojan Source" trick) are escaped. A result is at most 20,000
  characters. SPEC.md §2.4 has the exact rules.
- **Links get the same checks.** A link in a migrations folder must lead to a `.sql` file inside the
  project that does not look like a secret.
- **Keys never leave the server.** They come only from its environment, and never appear in a result,
  an error or a log line; an error about a malformed key setting names the bad pair by its position
  only. The log (stderr) has a startup line and one line per call: the tool, the time it took and the
  outcome code.
- **One schema lint at a time.** A second one gets `BUSY` straight away. The other two tools answer
  one call after another. Cancelling a lint stops its database at once.

## What it does not do

- Fix anything. Every tool is read-only; the agent writes the fix.
- Connect to a real database. It checks migration files, in a database that lives in memory and is
  thrown away.
- Read migrations written as code (Knex, TypeORM, Sequelize, Django, Rails, Alembic). Generate SQL
  first (`prisma migrate diff --script`, `drizzle-kit generate`, `pg_dump --schema-only`).
- MySQL, SQLite or SQL Server: PostgreSQL only. Extensions that PGlite does not have (PostGIS,
  pg_graphql, pg_net, pg_cron, pgsodium) make a migration fail with a clear error.
- Money kept in text or JSON columns, per-currency decimal places, FX, or chart-of-accounts rules.
- Defend against a hostile migration. A migration runs as a Postgres superuser and could edit the
  catalog to hide a column. money-guard catches mistakes, not deception.

## How it is tested

- `npm test` runs about 370 tests. The CI workflow runs them on Linux and Windows with Node 22, 24 and
  26, and on Node 22.12, the oldest the package supports; the badge at the top shows the latest run.
  - This README's example output and JSON, and the example results in SPEC.md (field by field, in
    order), are checked against what the tools return on the demo project.
  - Every sealed-audit-chain failure reason maps to its own code.
  - A real MCP client talks to the server in both protocol eras, in-process and as a separate process
    over stdio.
  - Security: path escapes (also through links in a migrations folder), secret files, a hostile
    project's names full of hidden characters, a migration that tries to read a real file on the
    machine (three ways) or run a program, an endless migration, a client's cancel, and a scan that no
    result or error holds a key.
  - stdout carries only protocol messages: a stand-in database thread that writes to stdout and
    stderr in every way it can is fully contained, and that test fails when the capture is removed.
  - Each test added in the review rounds was shown to fail on the code before its fix; the reviews
    are summed up in [How this was built](#how-this-was-built).
- CI also runs the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) 2.11.0
  in both protocol eras: `--strict` finds no schema-portability problem.
- CI installs the packed npm tarball into an empty project and starts it over stdio.
- CI builds the Claude Desktop bundle, unpacks it into an empty folder, starts it from its manifest and
  calls each tool, with the audit keys set and with them left blank.

## Development

```sh
npm ci && npm run typecheck && npm run lint && npm test
bash scripts/inspector-smoke.sh   # the MCP Inspector, in both protocol eras
```

[CLAUDE.md](CLAUDE.md) has the rules for changing the code. [SPEC.md](SPEC.md) is the contract: a
change in behaviour changes it first.

## How this was built

Written with Claude Code (every commit says so) and directed by the author, who set the scope, agreed
the spec and made the design decisions. The checks come from the author's own apps: the posting rules
of [integer-pence-ledger](https://github.com/Spundu/integer-pence-ledger) and the log format of
[audit-chain](https://github.com/Spundu/audit-chain). It has had no independent human review yet.

## License

MIT
