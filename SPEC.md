# money-guard-mcp: specification

This is the contract the code is built and tested against (agreed 2026-10-14). A change to what a tool
does changes this file first. §7 lists the tests that prove it.

---

## In short

**money-guard is a helper an AI coding agent (Claude Code, or any MCP client) can call while it works
on an app that handles money.** It only reads files. It never changes anything, never goes on the
internet and never touches a real database.

1. **Schema check** (`money_lint_schema`). The agent points it at the folder of database migration
   files. The tool runs them in a private, temporary Postgres that lives only in memory, then reads the
   real column types. It flags money stored as a "float" (floats lose pennies) or in Postgres's `money`
   type, names the migration file that did it, and gives the SQL to fix it. The agent writes the fix as
   a new migration and runs the check again; the check runs the fix too.
2. **Ledger check** (`money_check_double_entry`). The agent points it at an export (CSV, JSON or
   JSONL) and says which column is which. The tool checks that every transaction adds up to zero
   (debits = credits) and that every amount is whole pennies, using exact whole-number maths. It gives
   the exact line numbers of every problem.
3. **Audit log check** (`audit_verify_chain`). It uses
   [sealed-audit-chain](https://github.com/Spundu/audit-chain) to prove a log was not edited, reordered,
   forged or cut short. The secret key stays in the server's settings: the agent never sees it.

---

## 1. The facts this design rests on (checked 2026-10-14)

| # | Question | Answer | Source | What it changes |
|---|---|---|---|---|
| 1 | Are tool annotations in the 2026-07-28 schema? | **Yes.** `ToolAnnotations` has `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. They are hints only; clients must treat them as untrusted. `destructiveHint`/`idempotentHint` only mean something when `readOnlyHint` is false. | [schema.ts 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts) (`interface ToolAnnotations`); [tools page](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | As planned (§2.7). |
| 2 | Newest `server.json` schema? | **Still `2025-12-11`** (a draft has unreleased changes). `mcp-publisher` v1.8.1 (2026-08-06); Windows install is a PowerShell one-liner; `mcp-publisher login github` uses a device code (the maintainer does it). Publishing from GitHub Actions (OIDC) is also supported. | [server.json CHANGELOG](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md), [registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [releases](https://github.com/modelcontextprotocol/registry/releases) | None. |
| 3 | Does Claude Code speak 2026-07-28? | **Yes.** Since v2.1.292 it asks local (stdio) servers for 2026-07-28 by default (`MCP_PROTOCOL_NEGOTIATION=legacy` opts out). Since v2.1.139 stdio servers get `CLAUDE_PROJECT_DIR`. Output: warning above 10,000 tokens, cap 25,000 (`MAX_MCP_OUTPUT_TOKENS`); a result over 50,000 characters is saved to a file unless the tool sets `_meta["anthropic/maxResultSizeChars"]`. With tool search (the default) only tool **names and server instructions** load at start; descriptions are cut at 4,096 characters (loaded up front) or 16,384 (loaded by search); server instructions at 4,096. The Claude API refuses `anyOf`/`oneOf`/`allOf` at the **root** of an input schema (Claude Code flattens them); property names must be 1-64 characters of `A-Za-z0-9_.-`; schemas must pass the JSON Schema 2020-12 meta-schema. | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.1.292, 2.1.139, 2.1.91), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) | Server instructions must say when to use the tools. No root-level unions in input schemas. Every result stays under 20,000 characters. |
| 4 | SDK v2 version and API? | **`@modelcontextprotocol/server` 2.3.1** (2026-10-05), Node ≥ 20, zod ^4.2, Apache-2.0. `registerTool(name, { title, description, inputSchema, outputSchema, annotations, icons, _meta }, handler(args, ctx))`; `ctx.mcpReq.signal` reports cancellation. Arguments that fail the schema come back as an `isError` result before the handler runs; a thrown error becomes an `isError` result; output validation is skipped on `isError`. `maxToolInputElements` caps argument size. **Correction to the plan:** `serveStdio(factory, { legacy })` takes a **factory**, and its default is already `'serve'` (it also serves 2025 clients). **Testing correction:** `InMemoryTransport.createLinkedPair()` connects **2025-era** instances only; 2026-era in-process tests go through `createMcpHandler(factory)` + `handler.fetch`; stdio via `StdioClientTransport`; a client picks the era with `versionNegotiation` (`'auto'` or a pin on `'2026-07-28'`; the default is the 2025 handshake). | npm registry; SDK docs: [tools](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md), [errors](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md), [stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md), [legacy clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md), [testing](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md), [protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md); the installed `.d.ts` | Entry point is `serveStdio(createServer)`. Tests cover both eras (§7). |
| 5 | Inspector CLI flags? | **v2.11.0** (Node ≥ 22.19); the v1 flags changed. `npx --yes @modelcontextprotocol/inspector@2.11.0 --cli node dist/index.js --method tools/list --format json`; `--method tools/call --tool-name X --tool-args-json '{...}'`; `--protocol-era legacy\|auto\|modern`; `--strict` checks schema portability (exit 6). Exit codes: 0 ok, 1 usage, 4 unreachable, 5 tool error. | [Inspector README](https://github.com/modelcontextprotocol/inspector), [CLI smoke-testing guide](https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md), [CLI README](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md) | CI smoke test in both eras, `--strict` must report nothing (§7). |
| 6 | PGlite (for tool 1) | **0.5.9 = PostgreSQL 18.6** in 32-bit WebAssembly, Apache-2.0, ~26 MB. 34 contrib extensions ship with it (citext, pgcrypto, uuid-ossp, hstore, pg_trgm, ltree, ...), each registered when the database starts (all 34: ~1.5 s start). pgvector is a separate 67 KB package (`@electric-sql/pglite-pgvector` 0.0.10, needs PGlite 0.5.9): `CREATE EXTENSION vector` works. Runs inside a Node worker thread. Sees only a **virtual** filesystem: `COPY ... FROM '/etc/hosts'`, `pg_read_file()` and `lo_import()` of host paths fail. `COPY ... TO/FROM PROGRAM` runs **no** host program (a marker file it should have written never appeared), but it leaves that database stuck. Runs as superuser `postgres`; `CREATE ROLE` works. A failed multi-statement script is rolled back as a whole. Errors carry the SQLSTATE `code` and a 1-based `position`. A catalog query takes ~6 ms. | npm registry; a throwaway probe in the scratch folder (no repo code) | Tool 1 design (§3.4). |
| 7 | Other | `money-guard-mcp` and `sealed-audit-chain` are both **still free on npm**. `csv-parse` 7.0.3 is MIT with no dependencies. The 2026-07-28 security page: servers meant to run locally "SHOULD ... use the `stdio` transport to limit access to just the MCP client". | npm registry; [security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices) | stdio only. Claim the npm names soon. |

---

## 2. The server (rules for all three tools)

### 2.1 How it runs
- TypeScript, Node.js **22.12 or newer** (the same floor as sealed-audit-chain; CI runs Node 22, 24 and 26
  on **Ubuntu and Windows**, because path safety differs on Windows).
- Entry point: `serveStdio(createServer)` from `@modelcontextprotocol/server/stdio`. One binary serves
  MCP **2026-07-28** (`server/discover`, no `initialize`) and the **2025 era** (`initialize`), decided per
  connection.
- **stdio only.** No HTTP, no listening port. It reads local files, so a network endpoint would add
  attack surface and nothing else.
- Capabilities: **tools only.** No resources or prompts. No logging, sampling or roots (deprecated in
  2026-07-28).
- No network requests, no shell, no child processes. PGlite runs in a worker thread inside the same
  process.
- stdout carries only protocol messages. Diagnostics go to stderr: one line per call (tool, milliseconds,
  outcome code). The line never contains file content, keys or absolute paths.
- One bad call never kills the server. Every handler catches everything. An unexpected exception
  becomes `INTERNAL_ERROR` with no internal detail; the detail goes to stderr only.
- Starts in well under a second. PGlite loads only inside a `money_lint_schema` call, at about
  1.5 s per call.

### 2.2 Settings (environment variables, read once at startup)
| Variable | Meaning | Default |
|---|---|---|
| `MONEY_GUARD_ROOT` | The project folder the tools may read. | `CLAUDE_PROJECT_DIR` (Claude Code sets it for stdio servers), else the working directory. |
| `MONEY_GUARD_AUDIT_KEYS` | HMAC keys for `audit_verify_chain`, as `id=hex,id=hex`. | Not set: the audit tool answers `KEYS_NOT_CONFIGURED`. |

- A pure function resolves the settings once, at startup. Bad settings do **not** stop the server.
  Every tool that needs them answers with the error (`ROOT_INVALID`, `KEYS_INVALID`), so the model sees
  what is wrong and the other tools keep working.
- **Root rules:** it must exist and be a directory, and it must not be a filesystem root (`/`, `C:\`).
- **Key rules:** comma-separated pairs `id=hex`.
  - `id`: 1-64 characters, with no `=`, `,` or whitespace. Duplicate ids are invalid.
  - `hex`: an even number of hex digits, at least 32 (16 bytes = sealed-audit-chain's `MIN_KEY_BYTES`),
    in either case.
  - `KEYS_INVALID` names the position or the id that is wrong, never a key value.
- Claude Code project config. `${VAR:-}` expansion keeps the key out of the file and out of the repo:
  ```json
  { "mcpServers": { "money-guard": { "type": "stdio", "command": "npx", "args": ["-y", "money-guard-mcp"],
      "env": { "MONEY_GUARD_AUDIT_KEYS": "${MONEY_GUARD_AUDIT_KEYS:-}" } } } }
  ```
- Claude Desktop (MCPB): `user_config` gives a folder picker for the root and a field for the
  keys, marked `sensitive`.

### 2.3 Which files the tools may read
Every path argument:
1. is a string of 1-1,024 characters. It is relative to the root; an absolute path is accepted only if
   it lies inside the root.
2. is resolved with `realpath`, so symlinks are followed first and checked after. The real target must
   be inside the real root. The check is `path.relative(realRoot, realTarget)`: the result must not
   start with `..` and must not be absolute (on Windows a different drive comes back absolute).
3. must not contain NUL. Windows device and UNC forms are refused (`\\?\`, `\\.\`, `\\server\share`).
4. must be a regular file, or a directory where the tool says so.
5. must have one of the tool's allowed extensions (case-insensitive):
   - tool 1: `.sql`
   - tool 2: `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`
   - tool 3: `.jsonl`, `.ndjson`, `.log`
6. must not look like a secrets file. These are refused, at any depth:
   - `.env` and `.env.*`
   - `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`
   - `id_rsa*`, `id_ed25519*`
   - `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`
   - anything inside `.git/`

   This is defence in depth. The tools echo only tiny pieces of a file, but a read-only tool must
   never become a way to read secrets.

Paths in results are relative to the root and use `/`. Error messages name the root by its folder
name only, never its absolute path.
**Out of scope:** a local attacker who can swap symlinks between the check and the read (they could
already read the files).

### 2.4 What a successful result looks like
- `structuredContent`: a JSON object that the SDK validates against the tool's `outputSchema`. Plus
  one text block holding the same JSON (compact), as the spec recommends.
- The first field is always `summary`: one plain sentence for the model and for people.
- **Size budget: at most 20,000 characters per result.** That is well under Claude Code's
  50,000-character file threshold and its 25,000-token cap. Long lists are capped or paginated, and
  each cap is reported (`..._truncated`, `next_offset`).
- **Money values are strings of integer minor units** (`"-150"`). That is exact at any size; sums use
  `BigInt`. No floating point touches an amount, anywhere.
- **Data minimisation.** A value copied from a file into a result is cut at 40 characters (`…` marks
  the cut), with control characters escaped. A result never holds a whole line from a file, and never
  any key material.
- **Deterministic.** The same files and the same arguments give byte-identical results. Findings are
  sorted; there are no timestamps, durations or random ids. Tests and the eval cache rely on this.
- An optional parameter sent as `null` means "not given". Models sometimes send `null`; jarvis
  `vault-mcp` hit exactly this bug with zod's `.optional()`. A test proves it (§7).

### 2.5 Errors
- **Tool errors:** a result with `isError: true` and one text block: `CODE: what went wrong. Fix: what
  to do.` It has no `structuredContent` (the SDK skips output validation on errors). The code comes
  first, so a program can read it.
- **Protocol errors:** only for unknown tools and malformed requests (the SDK sends these).
- **Arguments that break the input schema** come back from the SDK as an `isError` result ("Input
  validation error: ...") before our handler runs. Every input object is strict (unknown keys are
  refused), so a misspelt parameter name is reported instead of silently ignored.

Shared error codes:

| Code | When | Fix the message suggests |
|---|---|---|
| `ROOT_INVALID` | The root is missing, not a folder, or a filesystem root. | Set `MONEY_GUARD_ROOT` to the project folder. |
| `PATH_INVALID` | Empty, too long, NUL, or a device/UNC path. | Pass a path relative to the project root. |
| `PATH_OUTSIDE_ROOT` | Resolves outside the root (including through a symlink). | Use a path inside the project. |
| `PATH_NOT_FOUND` | Nothing at that path. | Names the nearest existing parent folder. |
| `NOT_A_FILE` / `NOT_A_DIRECTORY` | Wrong kind of entry. | Says which one the tool expects. |
| `FILE_TYPE_NOT_ALLOWED` | The extension is not in the tool's list. | Lists the allowed extensions. |
| `SENSITIVE_PATH` | Matches the secrets list in §2.3. | The tools never read secret files. |
| `FILE_TOO_LARGE` | Over the tool's size limit. | States the limit; suggests a smaller export. |
| `BUSY` | Too many calls at once (§2.6). | Retry after the running call finishes. |
| `INTERNAL_ERROR` | A bug. | Details are in the server's log (stderr). |

### 2.6 Limits and concurrency
- At most **one** `money_lint_schema` runs at a time, because it starts a database. At most **8** tool
  calls are in progress at once. A call over either limit gets `BUSY` straight away; there is no hidden
  queue. (The MCP spec says servers MUST rate-limit tool calls.)
- A cancelled call stops its work. The `money_lint_schema` worker is terminated, and its database is
  discarded.
- Each tool's own limits are in its section.

### 2.7 How the tools are shown to the model
- Order: `money_lint_schema`, `money_check_double_entry`, `audit_verify_chain`. It never changes, and
  the tool list never changes (no `listChanged`).
- Titles:
  - `money_lint_schema`: "Lint money column types"
  - `money_check_double_entry`: "Check double-entry balance"
  - `audit_verify_chain`: "Verify audit log chain"
- Annotations on all three: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
  `openWorldHint: false`. The last three are for clients that read them even on read-only tools.
- `maxToolInputElements`: 2,500. The largest legitimate input is `files`, with at most 2,000 entries.
- Input schemas use no root-level `anyOf`/`oneOf`/`allOf`. Every property name matches
  `[A-Za-z0-9_.-]{1,64}`.
- **Server instructions** (exact text; it loads at session start and decides when the model searches
  for these tools):

  > money-guard checks how this project handles money. It is read-only and offline: it never edits
  > files, never connects to a database and never uses the network.
  > - money_lint_schema: after writing or reviewing SQL migrations that touch prices, amounts, fees,
  >   totals or balances. Runs the migrations in a throwaway PostgreSQL and reports money columns stored
  >   as float, numeric, smallint or the money type.
  > - money_check_double_entry: on a ledger or transactions export (CSV, JSON, JSONL), to prove every
  >   transaction's debits and credits net to zero in whole minor units.
  > - audit_verify_chain: on an audit log written with sealed-audit-chain, to prove no entry was
  >   edited, reordered, forged or cut off.
  >
  > Paths are relative to the project root. Fix schema findings with a NEW migration; never edit
  > migrations that may already have run. Never repair or re-seal an audit log that fails
  > verification: report it.

### 2.8 Dependencies
| Package | Why | Licence |
|---|---|---|
| `@modelcontextprotocol/server` ^2.3.1 | MCP server, both eras | Apache-2.0 |
| `zod` ^4.2 | Schemas (required by SDK v2) | MIT |
| `@electric-sql/pglite` **0.5.9 exactly** | PostgreSQL 18.6 in WebAssembly for tool 1 (its version appears in results) | Apache-2.0 |
| `@electric-sql/pglite-pgvector` **0.0.10 exactly** | `CREATE EXTENSION vector` (common in AI apps) | Apache-2.0 |
| `sealed-audit-chain` | Tool 3, and `parseJson` for tool 2. Comes from npm once published; until then `github:Spundu/audit-chain#5fd1fec` | MIT (same author) |
| `csv-parse` ^7 | RFC 4180 CSV with line numbers | MIT |

Dev only: `@modelcontextprotocol/client` (tests), typescript, vitest, eslint, typescript-eslint, and the
Inspector (pinned in CI through `npx`). The agent evaluation script uses `@anthropic-ai/sdk`.

### 2.9 Stability promise
Tool names, parameter names, output field names, finding codes and error codes are public API. A
**major** version is needed to change or remove one. A minor version may add a code or a field.

---

## 3. Tool 1: `money_lint_schema`

**Where it comes from:** the idea comes from Revwyn's `check-money-columns.mjs`. That script ran a
regex over the source; this tool runs the SQL instead, the lesson from `verification-instruments`,
whose regex SQL provers "never converged". Interview line: *verify by executing, not by parsing.*

### 3.1 Description (exact, shown to the model)
> Find database columns that store money unsafely. Runs the project's SQL migrations in order inside a
> throwaway in-memory PostgreSQL 18 (PGlite), then reads the real column types from the catalog, so
> the result is what Postgres actually built, not a guess from the SQL text. Reports money columns
> (names like price, amount, total, fee, balance, *_pence) stored as real/double precision (floats lose
> pennies) or as the money type (errors), and as numeric or smallint (warnings), each with the migration
> file that introduced it and an ALTER statement to fix it. Read-only: never connects to a real database
> and never changes files. Fix findings by adding a NEW migration, then run this tool again: it runs
> your fix too. If a migration fails because it needs objects your platform provides (Supabase roles,
> auth schema), pass preset or setup.

### 3.2 Input
| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `migrations` (required) | string, a path | | A folder of `.sql` migration files, or one `.sql` file (for example a `pg_dump --schema-only` file). |
| `files` | array of 1-2,000 paths, relative to `migrations` | every `.sql` file under the folder, in natural order (§3.3) | Run exactly these files, in this order. Use it when your tool orders migrations differently (Flyway `V…`/`R…` names, sqitch plans). Every entry must exist inside the folder. |
| `preset` | `"supabase"` | none | Built-in setup for Supabase projects (§3.4). |
| `setup` | string, a `.sql` path | none | A file run before the migrations (after `preset`), to create what your platform provides: roles, schemas, functions. Columns it creates are not checked. |
| `accept_numeric` | boolean | `false` | Treat `numeric`/`decimal` money columns as fine instead of warning about them. |
| `money_columns` | array of ≤ 200 names | none | Extra columns to treat as money: `"table.column"` (schema `public`) or `"schema.table.column"`. |
| `ignore_columns` | array of ≤ 200 names | none | Columns never to report (false positives), in the same format. They still count in `ignored_count`. |
| `timeout_seconds` | integer 5-300 | 60 | Stop after this long. |

### 3.3 Which files run, in which order
- **Default:** every `*.sql` file under `migrations`, at any depth, except files named `down.sql` or
  ending in `.down.sql` (golang-migrate and Diesel "down" steps).
- **Natural order** of the relative paths. Paths are compared folder by folder. Runs of digits compare
  by numeric value; everything else compares by character code. So `V2__x` comes before `V10__x`,
  `0001_a` before `0002_b`, and `20240101_x/migration.sql` before `20240202_y/migration.sql`. That
  ordering fits Drizzle, Prisma, Supabase, golang-migrate, node-pg-migrate SQL, Atlas and Diesel.
  Anything else passes `files`. The result lists the files it applied, so the order can be checked.
- **Two file-format conventions are honoured.** They are markers written by tools, not SQL syntax, so
  the "never parse SQL" rule still holds:
  - **dbmate:** a line exactly `-- migrate:down` ends the part that runs.
  - **pg_dump 17.6+/18:** lines starting `\restrict ` or `\unrestrict ` are blanked, keeping the same
    length, so line numbers stay exact.

  Any other psql meta-command (a line starting `\`) fails with a hint.

### 3.4 How it works
1. Check the paths, list the files and check the limits (§3.9).
2. Start a **worker thread** holding a fresh in-memory PGlite (PostgreSQL 18.6). All 34 bundled
   extensions plus pgvector are registered, so `CREATE EXTENSION` works for them. The database lives
   in memory and sees only a **virtual filesystem**: a migration cannot read or write the computer's
   files or run programs (§1, fact 6).
3. Run `preset` (if given), then `setup` (if given). Then take a **baseline snapshot** of the catalog.
   Columns already present at that point are never checked.
4. Run each migration file as **one script**, the same way `psql -f` would. After each file:
   - run a **sanity query** (`SELECT 1`, with its own 5-second limit). A file that leaves the database
     unusable or silent (for example `COPY ... PROGRAM`, which PGlite cannot run) fails as
     `MIGRATION_FAILED` for that file.
   - take a **snapshot**: every table column's declared type and base type. Domains are followed to
     their base type at any depth, and arrays to their element type.
   - Column identity is the table's internal id plus the column number, so renaming a table or a
     column does not lose track of it.
   - A file that fails stops the run. Postgres rolls that file back as a whole.
5. Classify the columns of every **ordinary and partitioned table** in non-system schemas. Excluded:
   - views
   - partitions (reported once, through their parent)
   - inherited columns (reported where they are defined)
   - tables created by extensions
6. For each finding, `introduced_in` is the earliest file after which the column has had its current
   type without a break. Examples:
   - created as float in `0001`, still float → `0001`.
   - created as numeric in `0001`, altered to float in `0005` → `0005`.
7. The worker is terminated at the time limit or on cancellation, and the database is discarded.
   Catalog queries name every object with its schema (`pg_catalog.`), so a migration that changes
   `search_path` cannot change what they read.

**Supabase preset** (in v1, decided 2026-10-14) creates the objects ordinary Supabase migrations use:
- roles `anon`, `authenticated`, `service_role`, `authenticator`
- schemas `auth`, `storage`, `extensions`
- table `auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, ...)`
- functions `auth.uid()`, `auth.role()`, `auth.jwt()` and `auth.email()`
- tables `storage.buckets` and `storage.objects`

That covers RLS policies `TO authenticated USING (auth.uid() = user_id)`, grants, `CREATE EXTENSION ...
WITH SCHEMA extensions`, and foreign keys to `auth.users`. A full `supabase db dump` still fails on
extensions that PGlite does not have (`pg_graphql`, `pg_net`, `pgsodium`, `pg_cron`). The error says
so and suggests linting `supabase/migrations` instead.

### 3.5 Which columns count as money
A column is checked as money when any of these is true:
- its **name** looks like money (rule below);
- its **type** is `money` (whatever its name);
- it is listed in `money_columns`.

Columns in `ignore_columns` are never reported.

**The name rule.** First split the name into lowercase words:
- at `_`, `-`, spaces and dots;
- at camelCase boundaries (`amountMinor` → amount, minor; `GBPAmount` → gbp, amount);
- between letters and digits.

The name looks like money when **any word is a money word** and **the last word is not a non-money
word**.

- **Money words:** amount, amounts, amt, balance, balances, charge, charges, cost, costs, discount,
  discounts, fee, fees, money, payment, payments, payout, payouts, pence, penny, cent, cents, minor,
  price, prices, refund, refunds, revenue, salary, salaries, subtotal, surcharge, tax, taxes, total,
  totals, vat, wage, wages, gbp, usd, eur.
- **Non-money last words:**
  - identifiers and labels: id, ids, uuid, key, ref, code, currency, ccy, type, kind, status, state,
    method, mode, reason, note, notes, description, desc, label, name, title, text, url, hash, flag,
    enabled, version
  - dates and times: date, at, on, time, ts, timestamp, year, month, week, day, days, hour, hours,
    minutes, seconds, ms
  - counts and order: count, number, num, no, qty, quantity, items, attempts, retries, rank, tier, level,
    band, position, priority, index, seq, sequence, step, stage
  - rates and measures: percent, percentage, pct, rate, ratio, bps, factor, multiplier, weight, score,
    distance, duration, km, kg
- **Examples that are money:** `total`, `unit_price`, `amount_pence`, `amountMinor`, `amount_due`,
  `platform_fee`, `balance_after`, `price_per_unit`, `total_gbp`.
- **Examples that are not:** `stripe_price_id`, `amount_currency`, `price_updated_at`, `total_count`,
  `tax_rate`, `fee_bps`, `total_items`, `payment_method`.

The lists are tested against a table of about 80 real column names (Stripe, Shopify, Supabase
templates and the author's own apps); the README lists them.

### 3.6 Findings
| Code | Severity | Rule |
|---|---|---|
| `FLOAT_MONEY` | error | A money column whose base type is `real` or `double precision`, or an array of them. |
| `MONEY_TYPE` | error | Any column whose base type is `money`, whatever its name. |
| `NUMERIC_MONEY` | warning | A money column whose base type is `numeric`/`decimal`. Silenced by `accept_numeric`. |
| `SMALLINT_MONEY` | warning | A money column whose base type is `smallint`, which holds at most 32,767 minor units (£327.67). |

`integer` and `bigint` money columns are fine. Money kept in text or JSON is not checked in v1 (too
many false positives).

Each finding carries a `fix_sql`: a starting point for the new migration, with identifiers quoted by
Postgres's own `quote_ident`.
- **`FLOAT_MONEY`, `NUMERIC_MONEY`:** `ALTER TABLE <t> ALTER COLUMN <c> TYPE bigint USING round(<c> * 100)::bigint;`
  It drops the `* 100` when the name already ends in pence/penny/cent/cents/minor.
- **`MONEY_TYPE`:** `... USING (<c>::numeric * 100)::bigint;`
- **`SMALLINT_MONEY`:** `... TYPE bigint;`
- **`null`** for domain, array and generated columns, where the fix belongs elsewhere (explained in
  `fixes`).

If a fix fails, for example because a view depends on the column, the next lint run shows it: the tool
runs the new migration too.

### 3.7 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | e.g. "2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied." |
| `migrations` | string | The path as given, normalised. |
| `migrations_sha256` | string | SHA-256 over every applied file (path, NUL, bytes, in run order): what was checked. |
| `postgres` | string | `"PostgreSQL 18.6 (PGlite 0.5.9)"` |
| `files_applied_count` | integer | |
| `files_applied` | string[] | The first 30, in run order, relative to the root. |
| `files_applied_truncated` | boolean | |
| `tables_checked` | integer | |
| `money_columns_checked` | integer | |
| `error_count`, `warning_count`, `ignored_count` | integer | Totals, including findings cut by the cap. |
| `findings` | Finding[] | Errors first, then warnings, then by table and column; **at most 50**. |
| `findings_truncated` | boolean | |
| `other_float_columns` | string[] | Float columns whose names do **not** look like money (`schema.table.column`, first 30), so the model can check none of them hold money. |
| `other_float_columns_count` | integer | |
| `fixes` | object | One plain explanation per code present (text in §3.10). |

**Finding:**
| Field | Type | Meaning |
|---|---|---|
| `code` | string | A code from §3.6. |
| `severity` | `"error"` or `"warning"` | |
| `table` | string | `schema.table` |
| `column` | string | |
| `type` | string | `"double precision"`, `"numeric(10,2)"`, `"pence (bigint)"` for a domain |
| `introduced_in` | string | The migration file, relative to the root. |
| `fix_sql` | string or null | |

### 3.8 Errors (besides §2.5)
| Code | When | Message contents |
|---|---|---|
| `MIGRATION_FAILED` | A migration file fails, or leaves the database unusable. | The file, line and column (from Postgres's `position`, counted in characters), SQLSTATE and the Postgres message (≤ 300 characters). It adds a targeted hint by SQLSTATE. |
| `SETUP_FAILED` | The preset or the `setup` file fails. | The same details. |
| `NO_SQL_FILES` | The folder has no `.sql` files. | What it found instead. For example: ".ts files: Knex/TypeORM migrations are code; generate SQL first (`drizzle-kit generate`, `prisma migrate diff --script`, `pg_dump --schema-only`)." |
| `TOO_MANY_FILES` | More than 2,000. | |
| `FILE_NOT_IN_FOLDER` | A `files` entry is missing, or lies outside `migrations`. | |
| `BAD_COLUMN_NAME` | A `money_columns`/`ignore_columns` entry is not `table.column` or `schema.table.column`. | |
| `TIMEOUT` | The time limit was hit. | Which file was running, and the limit. |

The `MIGRATION_FAILED` hints by SQLSTATE:
- **42704** (an object does not exist) and **3F000** (no such schema): "use `preset` or `setup`".
- **Extension not available:** the list of available extensions.
- **42601** (syntax error) on a line starting with `\`: "psql meta-command".
- **25001** (`CREATE INDEX CONCURRENTLY` inside a script): "leave this file out with `files` if it only
  creates indexes".

**Example:** `MIGRATION_FAILED: db/migrations/0004_rls.sql line 3, column 34: role "authenticated"
does not exist (SQLSTATE 42704). Fix: this file needs objects your platform creates. For a Supabase
project call again with preset "supabase"; otherwise pass setup, a .sql file that creates them.`

### 3.9 Limits
- At most 2,000 files.
- Each file at most 5 MiB; all files together at most 20 MiB.
- Time limit from `timeout_seconds`.
- One lint at a time.
- At most 50 findings in a result. The counts still cover them all, and the model fixes those and runs
  the tool again.

### 3.10 Example
Project files:
```
db/migrations/0001_init.sql     create table orders (id bigserial primary key, total double precision not null, currency text not null default 'GBP');
db/migrations/0002_fees.sql     alter table orders add column platform_fee numeric(10,2) not null default 0;
db/migrations/0003_payouts.sql  create table payouts (id bigserial primary key, amount_pence bigint not null, fee_pence bigint not null);
```
Call `{ "migrations": "db/migrations" }`. Result (hashes shortened; the real ones come from the step-3
fixtures):
```json
{
  "summary": "2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.",
  "migrations": "db/migrations",
  "migrations_sha256": "9c1e…",
  "postgres": "PostgreSQL 18.6 (PGlite 0.5.9)",
  "files_applied_count": 3,
  "files_applied": ["db/migrations/0001_init.sql", "db/migrations/0002_fees.sql", "db/migrations/0003_payouts.sql"],
  "files_applied_truncated": false,
  "tables_checked": 2,
  "money_columns_checked": 4,
  "error_count": 1,
  "warning_count": 1,
  "ignored_count": 0,
  "findings": [
    { "code": "FLOAT_MONEY", "severity": "error", "table": "public.orders", "column": "total",
      "type": "double precision", "introduced_in": "db/migrations/0001_init.sql",
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;" },
    { "code": "NUMERIC_MONEY", "severity": "warning", "table": "public.orders", "column": "platform_fee",
      "type": "numeric(10,2)", "introduced_in": "db/migrations/0002_fees.sql",
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING round(platform_fee * 100)::bigint;" }
  ],
  "findings_truncated": false,
  "other_float_columns": [],
  "other_float_columns_count": 0,
  "fixes": {
    "FLOAT_MONEY": "real and double precision are binary floating point: most decimal amounts (0.10, 19.99) cannot be stored exactly, and sums drift by fractions of a penny. Store integer minor units (pence, cents) in bigint: add a NEW migration with fix_sql (it multiplies by 100, assuming the column holds pounds or dollars with 2 decimals) and update the code that reads and writes the column. Renaming it to <column>_pence makes the unit clear.",
    "NUMERIC_MONEY": "numeric is exact, so this is not a rounding bug, but the amounts are not integer minor units: every piece of code must round the same way. Convert to bigint minor units, or pass accept_numeric: true if numeric is a deliberate choice."
  }
}
```
`fixes` text for the other two codes:
- **`MONEY_TYPE`:** "Postgres's money type depends on the lc_monetary setting, has a fixed number
  of decimals and no currency, and rounds silently. Store integer minor units in bigint, with the
  currency in its own column."
- **`SMALLINT_MONEY`:** "smallint holds at most 32,767 minor units (£327.67); a larger amount fails
  with an out-of-range error. Widen it to bigint; no data conversion is needed."

---

## 4. Tool 2: `money_check_double_entry`

**Where it comes from:** the posting rules of integer-pence-ledger (`assertBalanced` in
`src/db/post.ts`, `balanced()` and `assertPence` in `src/core`):
- at least two legs;
- no leg that moves nothing;
- whole pence only;
- the legs net to zero.

Those functions throw at the first problem. This tool returns **every** problem.

### 4.1 Description (exact, shown to the model)
> Check that a ledger export balances, exactly. Reads a CSV, JSON or JSONL file with one row per ledger
> leg (debit or credit), groups rows by transaction id and reports every transaction whose legs do not
> net to zero in each currency, that has fewer than two non-zero legs, or whose amounts are not whole
> minor units (10.5 pence) or cannot be read. Map the columns: transaction_id plus either a signed
> amount, an amount with a debit/credit side column, or separate debit and credit columns. Amounts are
> integers in minor units by default (amount_format "decimal" reads 12.34 as 1234); no floating point is
> used. Findings give the exact line numbers (or JSON Pointers) and are paginated with offset and
> limit. Read-only.

### 4.2 Input
| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `file` (required) | string, a path | | `.csv`, `.tsv`, `.json`, `.jsonl` or `.ndjson`. |
| `columns` (required) | object (strict) | | Which column (CSV) or field (JSON) holds what (below). |
| `amount_format` | `"minor_units"` or `"decimal"` | `"minor_units"` | `minor_units`: integers (`1234` = £12.34). `decimal`: `12.34`. |
| `decimal_places` | integer 0-4 | 2 | Decimal places allowed in `decimal` format (0 for JPY, 3 for BHD). |
| `format` | `"csv"`, `"json"` or `"jsonl"` | from the extension (`.csv`/`.tsv` csv, `.json` json, `.jsonl`/`.ndjson` jsonl) | Overrides the extension, e.g. for a `.json` file that holds one object per line. |
| `delimiter` | `","`, `";"`, `"\t"` or `"\|"` | `","` (`"\t"` for `.tsv`) | CSV only. |
| `records_pointer` | string (a JSON Pointer) | `""` (the root must be an array) | JSON only: where the array of records is, e.g. `"/data/entries"`. |
| `offset` | integer ≥ 0 | 0 | The first finding to return. |
| `limit` | integer 1-50 | 20 | How many findings to return. |

**`columns`:**
- `transaction_id` (required): it groups rows into transactions.
- `amount`, `side`, `debit`, `credit`, `currency`: optional, in one of three shapes:
  1. **`amount` alone:** signed amounts. Debits positive and credits negative, or the other way round;
     only the sum matters.
  2. **`amount` + `side`:** non-negative amounts. `side` is `D`, `DR` or `DEBIT`, or `C`, `CR` or
     `CREDIT`, in any case.
  3. **`debit` + `credit`:** each row's leg is debit − credit, and an empty cell counts as 0.

  Any other combination is `MAPPING_INVALID`. The rule is checked in the handler, because the Claude
  API refuses root-level `oneOf`.
- `currency` (optional). Without it, every row is the same currency.
- **JSON Pointers:** in JSON and JSONL, a name starting with `/` is a JSON Pointer into each record, so
  a nested `"/amount/value"` works. CSV names are used literally.
- **CSV header matching:** names match exactly. If there is no exact match, a unique case-insensitive
  match is used. A mapped name that appears twice in the header is `COLUMN_AMBIGUOUS`.

### 4.3 Reading the file
- **CSV:**
  - RFC 4180 via `csv-parse`. The first row is the header. UTF-8; a BOM is ignored. `\n` or `\r\n`.
  - Quoted fields may hold delimiters, `""` and line breaks.
  - Every row must have as many fields as the header (else `PARSE_ERROR` with the line). Blank lines
    are skipped.
  - Spaces around every value are ignored.
- **JSON:** the value at `records_pointer` must be an array. An element that is not an object is a
  `BAD_ROW` finding.
- **JSONL:** one JSON object per line. Blank lines are skipped. A line that is not a JSON object is a
  `BAD_ROW` finding, and the check goes on.
- **JSON parsing:** JSON is parsed with sealed-audit-chain's `parseJson` (strict RFC 8259, depth ≤ 100),
  **never `JSON.parse`**. V8 12.9 and later misparse escaped one-character keys; the author found that bug while building
  sealed-audit-chain.
- **Transaction ids** are compared exactly. A JSON number id becomes its text.
- **Currency** is trimmed and upper-cased.
- **Locations:** CSV and JSONL findings give **line numbers**: 1-based, the header is line 1, and a
  multi-line CSV record is reported at the line where it starts. JSON findings give **JSON Pointers**
  (`/data/entries/7`).

### 4.4 Amounts (exact: no floating point anywhere)
- **`minor_units`:** an integer.
  - Accepted: a JSON number with no fractional part, or a string `-?[0-9]+`.
  - A fraction (`10.5`) is `FRACTIONAL_MINOR_UNITS`. So is text with a decimal point even when the
    fraction is zero (`12.00`): it usually means the column holds pounds, so use `decimal`.
- **`decimal`:** a string or number of the form `-?[0-9]+(\.[0-9]+)?`.
  - Digits past `decimal_places` must be zeros: with 2 places `12.340` is 1234, and `12.345` is
    `FRACTIONAL_MINOR_UNITS`.
  - Converted to integer minor units with exact string arithmetic: `12.3` with 2 places is `1230`.
  - A JSON number is read through its shortest round-trip text. One that needs more than 15
    significant digits is `BAD_AMOUNT` ("write it as a string").
- **Refused as `BAD_AMOUNT` in text values:** thousands separators, currency symbols, `+`, brackets,
  exponents and empty text (the value is shown, ≤ 40 characters).
- A JSON number is judged by its value: `parseJson` keeps no number text, so `1000`, `1000.0` and
  `1e3` are the same amount.
- **Range:** every amount must fit ±(2^53 − 1) minor units (`AMOUNT_TOO_LARGE`). Sums use `BigInt`, so
  they are exact for any number of rows.

### 4.5 Findings
| Code | Severity | Level | Rule |
|---|---|---|---|
| `UNBALANCED` | error | transaction | In some currency the legs do not net to zero. `nets` lists each currency that is off. |
| `TOO_FEW_LEGS` | error | transaction | Fewer than two non-zero legs. |
| `ZERO_LEG` | warning | row | A leg of exactly 0. It moves nothing, and integer-pence-ledger refuses one. |
| `MISSING_VALUE` | error | row | A mapped value is missing or empty (`field` says which). |
| `BAD_AMOUNT` | error | row | Not a number in the chosen format (`value` shown). |
| `FRACTIONAL_MINOR_UNITS` | error | row | A fraction of a minor unit, or more decimal places than allowed. |
| `AMOUNT_TOO_LARGE` | error | row | Outside ±(2^53 − 1) minor units. |
| `BAD_SIDE` | error | row | A side value that is not D/DR/DEBIT/C/CR/CREDIT. |
| `NEGATIVE_WITH_SIDE` | error | row | A negative amount where `side` already gives the direction. |
| `BAD_ROW` | error | row | A JSON or JSONL record that is not an object, or a JSONL line that is not JSON. |

A transaction with any row error is **not checked** for `UNBALANCED` or `TOO_FEW_LEGS`; its sum would
be noise. It is counted in `transactions_not_checked`. A transaction with fewer than two non-zero legs is
reported as `TOO_FEW_LEGS` only: its imbalance follows from that. A row without a transaction id is
reported on its own (`MISSING_VALUE`, `transaction_id: null`).

**Finding:**
| Field | Type | Meaning |
|---|---|---|
| `code`, `severity` | | As above. |
| `transaction_id` | string or null | Cut at 40 characters for display. Grouping always uses the full id. |
| `lines` | integer[] | CSV and JSONL: the rows involved, at most 20. |
| `pointers` | string[] | JSON: the records involved, at most 20. |
| `more_rows` | integer | How many rows were left out of `lines`/`pointers`. |
| `field` | string | For row findings: `amount`, `side`, `debit`, `credit`, `currency`, `transaction_id`, or `debit/credit` when both are empty. |
| `value` | string | The offending text, ≤ 40 characters. |
| `nets` | `{ currency: string or null, net: string }[]` | For `UNBALANCED`. |
| `message` | string | ≤ 120 characters, e.g. "GBP legs net to -1, not 0". |

Findings are sorted by their first location, then by code.

### 4.6 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | |
| `file`, `format`, `file_sha256` | string | `file_sha256` tells the model the file did not change between pages. |
| `rows_read` | integer | |
| `transactions_found`, `transactions_checked`, `transactions_balanced`, `transactions_not_checked` | integer | |
| `balanced` | boolean | True only when there is at least one row and no errors. An empty file proves nothing, so it is false. |
| `error_count`, `warning_count` | integer | Over all pages. |
| `counts_by_code` | object | e.g. `{ "UNBALANCED": 1 }`, over all pages. |
| `findings` | Finding[] | This page. |
| `offset`, `limit`, `total_findings` | integer | |
| `next_offset` | integer or null | null on the last page. |

### 4.7 Errors (besides §2.5)
| Code | When |
|---|---|
| `PARSE_ERROR` | Broken CSV (an unclosed quote, the wrong number of fields) or invalid JSON (`json` format). Gives the line and column. |
| `COLUMN_NOT_FOUND` | A mapped CSV column is not in the header. Lists up to 30 header names (each ≤ 40 characters) and the closest match. |
| `COLUMN_AMBIGUOUS` | A mapped name appears twice in the header. |
| `MAPPING_INVALID` | The `columns` shape is not one of the three in §4.2. |
| `RECORDS_NOT_ARRAY` | The JSON value at `records_pointer` is not an array. Says what it is, e.g. "an object with keys data, meta" (≤ 20 keys, ≤ 40 characters each). |
| `TOO_MANY_ROWS` | More than 1,000,000 rows. |

### 4.8 Limits
- The file is at most 25 MiB and holds at most 1,000,000 rows.
- JSON nests at most 100 levels.
- At most 20 locations per finding.
- Pages of at most 50 findings.
- Each call re-reads the file, so nothing is stored between calls (the 2026-07-28 protocol has no
  sessions).

### 4.9 Example
`exports/journal.csv`:
```
txn_id,account,amount_pence,currency
T1,cash,1000,GBP
T1,sales,-1000,GBP
T2,cash,1999,GBP
T2,sales,-2000,GBP
T3,fees,10.5,GBP
T3,cash,-10.5,GBP
T4,cash,0,GBP
T4,sales,500,GBP
T4,vat,-500,GBP
```
Call `{ "file": "exports/journal.csv", "columns": { "transaction_id": "txn_id", "amount": "amount_pence", "currency": "currency" } }`:
```json
{
  "summary": "Not balanced: 3 errors and 1 warning. 4 transactions: 2 balanced, 1 unbalanced, 1 not checked (rows with unreadable values).",
  "file": "exports/journal.csv",
  "format": "csv",
  "file_sha256": "41d7…",
  "rows_read": 9,
  "transactions_found": 4,
  "transactions_checked": 3,
  "transactions_balanced": 2,
  "transactions_not_checked": 1,
  "balanced": false,
  "error_count": 3,
  "warning_count": 1,
  "counts_by_code": { "UNBALANCED": 1, "FRACTIONAL_MINOR_UNITS": 2, "ZERO_LEG": 1 },
  "findings": [
    { "code": "UNBALANCED", "severity": "error", "transaction_id": "T2", "lines": [4, 5],
      "nets": [{ "currency": "GBP", "net": "-1" }], "message": "GBP legs net to -1, not 0" },
    { "code": "FRACTIONAL_MINOR_UNITS", "severity": "error", "transaction_id": "T3", "lines": [6],
      "field": "amount", "value": "10.5", "message": "10.5 is not a whole number of minor units" },
    { "code": "FRACTIONAL_MINOR_UNITS", "severity": "error", "transaction_id": "T3", "lines": [7],
      "field": "amount", "value": "-10.5", "message": "-10.5 is not a whole number of minor units" },
    { "code": "ZERO_LEG", "severity": "warning", "transaction_id": "T4", "lines": [8],
      "field": "amount", "value": "0", "message": "a leg of 0 moves nothing" }
  ],
  "offset": 0,
  "limit": 20,
  "total_findings": 4,
  "next_offset": null
}
```

---

## 5. Tool 3: `audit_verify_chain`

**Where it comes from:** `verifyJsonl(bytes, keys, anchor)` from sealed-audit-chain
(github.com/Spundu/audit-chain).
- It checks the file byte for byte and streams through it.
- It stops at the first failure.
- It never throws on file content.
- Its verdicts are proven identical to the Python verifier.

### 5.1 Description (exact, shown to the model)
> Prove an audit log was not edited, reordered, forged or cut short. Verifies a log written with
> sealed-audit-chain (one canonical JSON entry per line, each sealed with HMAC-SHA-256 and linked to the
> previous entry by SHA-256) byte for byte, and returns the first broken entry with its line and a
> reason code. The HMAC keys come from the server's configuration, never from arguments, and are never
> returned. Pass the anchor (count and last_hash) that a previous successful run returned as head to
> also detect entries removed from the end. Read-only: if a log fails, report it; never repair or
> re-seal it.

### 5.2 Input
| Parameter | Type | Meaning |
|---|---|---|
| `file` (required) | string, a path | `.jsonl`, `.ndjson` or `.log`. |
| `anchor` | object (strict): `count` integer 0 to 2^53 − 1, `last_hash` 64 lowercase hex | From an earlier run's `head`, or from wherever the app stores it. Detects entries removed from the end. |

### 5.3 How it works
1. Check the path. Read the file once (≤ 100 MiB).
2. Build an `InMemoryKeyProvider` from `MONEY_GUARD_AUDIT_KEYS`. The keys never appear in a result, an
   error or a log line.
3. Call `verifyJsonl(bytes, keys, anchor)`, and map the library's reason to a stable code (§5.4).
4. For `UNKNOWN_KEY_ID` and `HMAC_MISMATCH`, read that one entry's `writer_key_id` with `jsonlEntryAt`,
   so the message can say which key is missing (≤ 64 characters).
5. When the log verifies, return its `head` (`count` and `last_hash`) as the anchor to keep.

### 5.4 Reason codes
| Code | sealed-audit-chain reason | Plain meaning |
|---|---|---|
| `TORN_LAST_LINE` | last line is not terminated (torn) | A write was cut off, or the file was cut mid-line. |
| `LINE_TOO_LARGE` | line exceeds the canonical size limit | |
| `NOT_UTF8` | line is not valid UTF-8 | |
| `NOT_JSON` | line is not valid JSON | |
| `NOT_CANONICAL` | line is not in canonical form | The bytes were rewritten (spacing, key order, escapes). |
| `OUTSIDE_CANONICAL_DOMAIN` | line is outside the canonical domain | Floats, unsafe integers, lone surrogates or too deep. |
| `NOT_AN_OBJECT` | entry is not an object | |
| `SEQ_MISMATCH` | seq mismatch: expected N | Entries were inserted, removed or reordered. |
| `LINK_BROKEN` | prev_hash linkage broken (reorder/delete) | |
| `NOT_CANONICALIZABLE` | not canonicalizable: … | |
| `CONTENT_TAMPERED` | entry_hash mismatch (content tampered) | The entry was edited after sealing. |
| `UNKNOWN_KEY_ID` | unknown writer_key_id | No key is configured for this entry's key id. |
| `HMAC_MISMATCH` | HMAC mismatch (forged or unsealed) | Forged, or sealed with a different key. |
| `ENTRY_TOO_LARGE` | entry exceeds the canonical size limit | |
| `ANCHOR_COUNT_MISMATCH` | count N != anchor count (truncation) | Entries are missing at the end (or were added). |
| `ANCHOR_HEAD_MISMATCH` | head hash does not match anchor | The log was replaced or rolled back. |
| `OTHER` | anything else | Only if a newer library adds a reason. The raw reason is included. |

A test produces every reason the library can return through `verifyJsonl` and fails if one is not
mapped.

### 5.5 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | |
| `file`, `file_sha256` | string | |
| `ok` | boolean | |
| `entries_verified` | integer | The entries vouched for before any break (the library's `lastSeq + 1`). |
| `break` | object or null | `{ entry_index, line, code, reason, writer_key_id? }`. `line` = `entry_index + 1`, or null when that line does not exist (an anchor that counts more entries). |
| `anchor_checked` | boolean | |
| `head` | object or null | `{ count, last_hash }` when `ok`. Keep it and pass it as `anchor` next time. |
| `key_ids_configured` | string[] | Ids only, never key bytes. |
| `notes` | string[] | e.g. "No anchor was given, so entries removed from the end cannot be detected." For an empty log: "An empty log always verifies; pass an anchor to detect a deleted or emptied log." |

### 5.6 Errors (besides §2.5)
| Code | When |
|---|---|
| `KEYS_NOT_CONFIGURED` | `MONEY_GUARD_AUDIT_KEYS` is unset or empty. The fix text says how to set it in the server's env (`.mcp.json` with `${...}`), never in chat. |
| `KEYS_INVALID` | The setting is malformed. Names the position or id, never a value. |

A bad `anchor` (wrong hex, a negative count) is refused by the input schema.

### 5.7 Limits
The file is at most 100 MiB. Verification is linear and stops at the first break.

### 5.8 Example
A log written by the audit-chain quickstart (two entries, key id `k1`). Call `{ "file": "logs/audit.jsonl" }`:
```json
{
  "summary": "The log verifies: 2 entries, every seal and link intact. Keep head and pass it as anchor next time.",
  "file": "logs/audit.jsonl",
  "file_sha256": "5b0d…",
  "ok": true,
  "entries_verified": 2,
  "break": null,
  "anchor_checked": false,
  "head": { "count": 2, "last_hash": "e3a1…" },
  "key_ids_configured": ["k1"],
  "notes": ["No anchor was given, so entries removed from the end cannot be detected."]
}
```
After someone changes `alice` to `mallory` in the first entry:
```json
{
  "summary": "The log does NOT verify: entry 0 (line 1) was edited after it was sealed (CONTENT_TAMPERED).",
  "file": "logs/audit.jsonl",
  "file_sha256": "a77f…",
  "ok": false,
  "entries_verified": 0,
  "break": { "entry_index": 0, "line": 1, "code": "CONTENT_TAMPERED", "reason": "entry_hash mismatch (content tampered)" },
  "anchor_checked": false,
  "head": null,
  "key_ids_configured": ["k1"],
  "notes": ["No anchor was given, so entries removed from the end cannot be detected."]
}
```

---

## 6. Not in v1 (said plainly in the README)
- Writing or fixing anything. Every tool is read-only.
- Connecting to a real database. Only migration files are checked. A read-only `DATABASE_URL` mode
  could come later.
- Migrations written as code (Knex, TypeORM, Kysely, Sequelize, Django, Rails, Alembic): generate SQL
  first.
- MySQL, SQLite and SQL Server. PostgreSQL only.
- Extensions PGlite does not have (PostGIS, pg_graphql, pg_net, pg_cron, pgsodium): those migrations
  fail with a clear error.
- Money stored as text or JSON; exponents per currency (ISO 4217); FX transactions; chart-of-accounts
  rules. integer-pence-ledger has those; a later "ledger profile" could reuse its `assertAccountUsage`.
- HTTP transport, resources, prompts.
- Audit logs in other formats.
- A migration written to deceive the checker. It runs as a Postgres superuser and could edit the
  system catalogs. money-guard catches mistakes; it is not a defence against hostile migrations.

---

## 7. How it is proven (acceptance tests)
- **Fixture projects** (synthetic, in `fixtures/`; nothing copied from private code):
  - Schemas:
    - `shop-float` (float money → `FLOAT_MONEY`) and `shop-clean` (bigint pence → no findings);
    - `supabase-app` (needs the preset);
    - `flyway` (needs `files`), `dbmate` (up/down markers) and a `pg_dump` 18 file with `\restrict`;
    - `broken-migration` (`MIGRATION_FAILED` with exact line and column);
    - `infinite-loop` (`DO $$ BEGIN LOOP END LOOP; END $$;` must stop at the time limit, which proves
      the worker can be killed mid-WebAssembly).
  - Ledgers: balanced, unbalanced, fractional, decimal mode, debit/credit columns, a side column, a
    nested JSON Pointer, and a JSONL file with one bad line.
  - Audit logs: one valid log, plus one per reason code (tampered, reordered, middle entry deleted,
    tail cut with an anchor, torn line, wrong key, forged HMAC, rewritten whitespace).
- **Every finding code and every error code** has a test that produces it. Every sealed-audit-chain
  reason maps to its code.
- **Name-rule table:** about 80 real column names with the expected money/not-money answer.
- **Security:**
  - `../` escapes, absolute paths outside the root and symlink escapes are refused. A test that cannot
    create symlinks (Windows without Developer Mode) skips **loudly**.
  - `.env`, `id_rsa` and UNC paths are refused.
  - A migration reading `/etc/hosts` finds nothing.
  - No output ever contains a configured key: a test scans every result and error.
  - Every value echoed from a file is ≤ 40 characters.
- **Protocol:**
  - in-process tests through `createMcpHandler` + `handler.fetch` in **both eras** (pinned 2026-07-28,
    and the default 2025 handshake);
  - spawned-stdio tests in both eras;
  - an Inspector CLI job in CI: `tools/list --strict` reports nothing, one `tools/call` per tool, and a
    refused path exits 5.
- **Input edge cases:** every optional parameter sent as `null` behaves as if omitted. Unknown
  parameters are refused.
- **Determinism:** the same input twice gives identical bytes. **Size:** the worst-case fixtures stay
  ≤ 20,000 characters.
- **Phase A lessons:**
  - every new test is shown to fail without the code it covers;
  - README examples are files run in CI, with their exact output checked;
  - review rounds go on until one finds no HIGH;
  - a fresh-clone rehearsal comes before publishing.

---

## 8. Design decisions (2026-10-14)
1. **Supabase preset in v1? → YES.** Many AI-built apps use Supabase, and without the
   preset their migrations fail on `auth.users` or `TO authenticated`. Cost: about half a day,
   including a fixture.
2. **How strict about `numeric` money columns? → A WARNING**, which `accept_numeric: true` turns
   off. `numeric` is exact, so it is not a rounding bug, but money-guard's own approach is integer
   minor units. The other choices are an error, or no report at all.
