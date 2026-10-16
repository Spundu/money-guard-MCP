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
   type, names the migration file that did it and, where the conversion is clear, gives the SQL that
   starts the fix. The agent writes the fix as a new migration and runs the check again; the check runs
   the fix too.
2. **Ledger check** (`money_check_double_entry`). The agent points it at an export (CSV, JSON or
   JSONL) and says which column is which. The tool checks that every transaction adds up to zero
   (debits = credits) and that every amount is whole pennies, using exact whole-number maths. It gives
   the line number (or, in JSON, the JSON Pointer) of every problem.
3. **Audit log check** (`audit_verify_chain`). It uses
   [sealed-audit-chain](https://github.com/Spundu/audit-chain) to prove a log was not edited, reordered
   or forged and, given the head of an earlier check, not cut short. The secret key stays in the
   server's settings: money-guard never returns, logs or asks for it (§2.2 says what an agent with a
   shell can still read).

---

## 1. The facts this design rests on (checked 2026-10-14)

| # | Question | Answer | Source | What it changes |
|---|---|---|---|---|
| 1 | Are tool annotations in the 2026-07-28 schema? | **Yes.** `ToolAnnotations` has `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. They are hints only; clients must treat them as untrusted. `destructiveHint`/`idempotentHint` only mean something when `readOnlyHint` is false. | [schema.ts 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts) (`interface ToolAnnotations`); [tools page](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | As planned (§2.7). |
| 2 | Newest `server.json` schema? | **Still `2025-12-11`** (a draft has unreleased changes). `mcp-publisher` v1.8.1 (2026-08-06); Windows install is a PowerShell one-liner; `mcp-publisher login github` uses a device code (the maintainer does it). Publishing from GitHub Actions (OIDC) is also supported. | [server.json CHANGELOG](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/CHANGELOG.md), [registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [releases](https://github.com/modelcontextprotocol/registry/releases) | None. |
| 3 | Does Claude Code speak 2026-07-28? | **Yes.** Since v2.1.292 it asks local (stdio) servers for 2026-07-28 by default (`MCP_PROTOCOL_NEGOTIATION=legacy` opts out). Since v2.1.139 stdio servers get `CLAUDE_PROJECT_DIR`. Output: warning above 10,000 tokens, cap 25,000 (`MAX_MCP_OUTPUT_TOKENS`); a result over 50,000 characters is saved to a file unless the tool sets `_meta["anthropic/maxResultSizeChars"]`. With tool search (the default) only tool **names and server instructions** load at start; descriptions are cut at 4,096 characters (loaded up front) or 16,384 (loaded by search); server instructions at 4,096. The Claude API refuses `anyOf`/`oneOf`/`allOf` at the **root** of an input schema (Claude Code flattens them); property names must be 1-64 characters of `A-Za-z0-9_.-`; schemas must pass the JSON Schema 2020-12 meta-schema. | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.1.292, 2.1.139, 2.1.91), [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) | Server instructions must say when to use the tools. No root-level unions in input schemas. Every result stays under 20,000 characters. |
| 4 | SDK v2 version and API? | **`@modelcontextprotocol/server` 2.3.1** (2026-10-05), Node ≥ 20, zod ^4.2, Apache-2.0. `registerTool(name, { title, description, inputSchema, outputSchema, annotations, icons, _meta }, handler(args, ctx))`; `ctx.mcpReq.signal` reports cancellation. Arguments that fail the schema come back as an `isError` result before the handler runs; a thrown error becomes an `isError` result; output validation is skipped on `isError`. `maxToolInputElements` caps argument size. **Correction to the plan:** `serveStdio(factory, { legacy })` takes a **factory**, and its default is already `'serve'` (it also serves 2025 clients). **Testing correction:** `InMemoryTransport.createLinkedPair()` connects **2025-era** instances only; 2026-era in-process tests go through `createMcpHandler(factory)` + `handler.fetch`; stdio via `StdioClientTransport`; a client picks the era with `versionNegotiation` (`'auto'` or a pin on `'2026-07-28'`; the default is the 2025 handshake). | npm registry; SDK docs: [tools](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md), [errors](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md), [stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md), [legacy clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md), [testing](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md), [protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md); the installed `.d.ts` | Entry point is `serveStdio(createServer)`. Tests cover both eras (§7). |
| 5 | Inspector CLI flags? | **v2.11.0** (Node ≥ 22.19); the v1 flags changed. `npx --yes @modelcontextprotocol/inspector@2.11.0 --cli node dist/index.js --method tools/list --format json`; `--method tools/call --tool-name X --tool-args-json '{...}'`; `--protocol-era legacy\|auto\|modern`; `--strict` checks schema portability (exit 6). Exit codes: 0 ok, 1 usage, 4 unreachable, 5 tool error. | [Inspector README](https://github.com/modelcontextprotocol/inspector), [CLI smoke-testing guide](https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md), [CLI README](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md) | CI smoke test in both eras, `--strict` must report nothing (§7). |
| 6 | PGlite (for tool 1) | **0.5.9 = PostgreSQL 18.6** in 32-bit WebAssembly, Apache-2.0, ~26 MB. 34 contrib modules ship with it (citext, pgcrypto, uuid-ossp, hstore, pg_trgm, ltree, ...), each registered when the database starts (all 34: ~1.5 s start): 33 extensions and auto_explain, a module, not an extension. §3.4 lists the 38 names `CREATE EXTENSION` can load: those 33, autoinc, insert_username and refint (built in, with no module of their own), plpgsql and pgvector. pgvector is a separate 67 KB package (`@electric-sql/pglite-pgvector` 0.0.10, needs PGlite 0.5.9): `CREATE EXTENSION vector` works. Runs inside a Node worker thread. Sees only a **virtual** filesystem: `COPY ... FROM '/etc/hosts'`, `pg_read_file()` and `lo_import()` of host paths fail. `COPY ... TO/FROM PROGRAM` runs **no** host program (a marker file it should have written never appeared), but it leaves that database stuck. Runs as superuser `postgres`; `CREATE ROLE` works. A failed multi-statement script is rolled back as a whole. Errors carry the SQLSTATE `code`, and a 1-based `position` when the error points at a place in the text (a syntax error, often an unknown name or schema; not a missing role or a duplicate table). A catalog query takes ~6 ms. | npm registry; a throwaway probe in the scratch folder (no repo code) | Tool 1 design (§3.4). |
| 7 | Can one process start a PGlite thread while another ends? | **Not safely on Node.js 24.** Its V8 (13.6) can free a wasm-to-JS import wrapper twice when a thread with WebAssembly is torn down while another thread looks the wrapper up, and then aborts the whole process (`Check failed: jit_page_->allocations_.erase(addr) == 1`). Fixed in V8 (9b8ca54d5a, 68210d500a); the Node.js 24 backport is still open; Node.js 22 and 26 are not affected. Review round 4 saw it twice in nine full test runs. | [nodejs/node#66366](https://github.com/nodejs/node/issues/66366), [nodejs/node#66376](https://github.com/nodejs/node/pull/66376) | One database thread at a time (§3.4). That makes it rare, not impossible: review round 17 saw a full test run on a busy Windows machine end with it once. CI runs the tests once more only after this abort (`scripts/test-ci.mjs`). |
| 8 | Other | `money-guard-mcp` and `sealed-audit-chain` are both **still free on npm**. `csv-parse` 7.0.3 is MIT with no dependencies. The 2026-07-28 security page: servers meant to run locally "SHOULD ... use the `stdio` transport to limit access to just the MCP client". | npm registry; [security best practices](https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices) | stdio only. |

---

## 2. The server (rules for all three tools)

### 2.1 How it runs
- TypeScript, Node.js **22.12 or newer** (the same floor as sealed-audit-chain). CI is set up to run
  Node 22, 24 and 26 on **Ubuntu and Windows**, because path safety differs on Windows; it runs on every
  push to `main` and every pull request to `main`, so it starts with the first push.
- Entry point: `serveStdio(createServer)` from `@modelcontextprotocol/server/stdio`. One binary serves
  MCP **2026-07-28** (`server/discover`, no `initialize`) and the **2025 era** (`initialize`), decided per
  connection.
- **stdio only.** No HTTP, no listening port. It reads local files, so a network endpoint would add
  attack surface and nothing else.
- Capabilities: **tools only.** No resources or prompts. No logging, sampling or roots (deprecated in
  2026-07-28).
- No network requests, no shell, no child processes. PGlite runs in a worker thread inside the same
  process.
- stdout carries only protocol messages. Diagnostics go to stderr: a startup line (version, Node.js
  version, the project folder's name, how many key ids, or that the key setting is malformed), one
  line per call (tool, milliseconds, and the outcome: `ok`, an error code, `CANCELLED` when the client
  cancelled the call, or `DISCONNECTED` when the client went away while a lint ran; a call the client
  gave up on gets no answer, whatever the tool did; a ledger or audit call, which cannot be stopped
  part-way, is answered and logged `ok` even when stdin closes while it runs), and the type of any transport error (for example a message
  over the SDK's 10 MiB stdio limit, after which the SDK closes the connection). A call the SDK refuses
  before the handler runs (bad arguments, an unknown tool) is not logged. No line contains file
  content, keys or absolute paths; an unexpected error is logged as its type, its error code (such as
  `EBUSY`) and its `file:line:column` locations only, then the same for its cause.
- The log is a convenience and never holds up an answer. Lines are written one at a time in the
  background (on Windows, Node would otherwise wait until the host reads the pipe); while one waits, at
  most 100 more queue up and later ones are dropped. When the host closes the server's stderr, never
  reads it, or dies, the server keeps serving without it, and still exits when stdin closes.
- One bad call never kills the server. Every handler catches everything. An unexpected exception
  becomes `INTERNAL_ERROR` with no internal detail; the detail goes to stderr only. A lint database
  that cannot start (a broken install) is such an exception.
- Starts in well under a second. PGlite loads only inside a `money_lint_schema` call, at about
  1.5 s per call.

### 2.2 Settings (environment variables, read once at startup)
| Variable | Meaning | Default |
|---|---|---|
| `MONEY_GUARD_ROOT` | The project folder the tools may read. | `CLAUDE_PROJECT_DIR` (Claude Code sets it for stdio servers), else the working directory. |
| `MONEY_GUARD_AUDIT_KEYS` | HMAC keys for `audit_verify_chain`, as `id=hex,id=hex`. | Not set: the audit tool answers `KEYS_NOT_CONFIGURED`. |

- A function resolves the settings once, at startup (it reads the file system only to check the root). Bad settings do **not** stop the server.
  Every tool that needs them answers with the error (`ROOT_INVALID`, `KEYS_INVALID`), so the model sees
  what is wrong and the other tools keep working.
- **A value that is still a `${...}` placeholder is not set.** Claude Code leaves `${VAR}` as it is
  when `VAR` is not set, and Claude Desktop leaves `${user_config.x}` when an optional setting has no
  value. For the keys that is `KEYS_NOT_CONFIGURED`, naming the placeholder. For the root it is
  `ROOT_INVALID`: a broken setting never falls back to another folder.
- **Root rules:** it must exist and be a directory the server may open, and it must not be a filesystem
  root (`/`, `C:\`).
- **Key rules:** comma-separated pairs `id=hex`, at most 64 pairs (every audit result lists the ids).
  - `id`: 1-64 characters, with no `=`, `,`, whitespace, control or invisible characters, and not 32
    or more hex digits: every audit result lists the ids, so a key written where the id belongs would
    be shown to the model. Duplicate ids are invalid.
  - `hex`: an even number of hex digits, at least 32 (16 bytes = sealed-audit-chain's `MIN_KEY_BYTES`),
    in either case.
  - `KEYS_INVALID` names the pair that is wrong by its position only ("pair 2"), never by any of its
    text: in a malformed setting the text before `=` may be a key.
- **What money-guard promises about keys:** it never returns, logs or asks for one. It cannot stop an
  agent that runs shell commands from reading what its host can read: with the `.mcp.json` below, the
  key is in the environment Claude Code started with, which `printenv` shows. Anyone who holds the key
  can re-seal a forged log so that it verifies. Where the agent must not be able to do that, verify
  logs in a client where no tool can run commands or read the user's files (Claude Desktop with no
  extension that can).
- Claude Code project config, once the package is on npm (until then `"command": "node"` with the
  path to `dist/index.js`). `${VAR:-}` expansion keeps the key out of the file and out of the repo:
  ```json
  { "mcpServers": { "money-guard": { "type": "stdio", "command": "npx", "args": ["-y", "money-guard-mcp"],
      "env": { "MONEY_GUARD_AUDIT_KEYS": "${MONEY_GUARD_AUDIT_KEYS:-}" } } } }
  ```
  On native Windows, `npx` needs a shell to start: `"command": "cmd", "args": ["/c", "npx", "-y", "money-guard-mcp"]`.
- **Claude Desktop (MCPB):** `mcpb/manifest.json` (manifest version 0.3) gives a folder picker for the
  root (`project_folder`, required) and a field for the keys (`audit_keys`, `sensitive`). The keys
  field has `default: ""`, so a blank field reaches the server as an empty value, not as a placeholder.
  `npm run bundle` builds `money-guard-mcp-<version>.mcpb` from the packed npm tarball, with
  production dependencies only. It then unpacks the bundle and starts it as its manifest says (§7).
  The bundle will ship on GitHub Releases.

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
   - cloud credential downloads, which are `.csv`, `.tsv`, `.json`, `.jsonl` and `.ndjson` files (every
     type the ledger tool reads): names holding `credentials` or `credential` as a word
     (`credentials.csv`, AWS's `alice_credentials.csv`, `application_default_credentials.json`),
     `accesskeys`, `access_keys`, `rootkey`, `client_secret`, `service-account`, `serviceaccount`
     or `adminsdk` (AWS access-key downloads, Google OAuth, service-account and Firebase keys); names
     starting `secrets` or `.secrets` and then `.`, `_` or `-` (`secrets.json`, not `secretsanta.csv`), or named `secret` (`secret.json`, `app-secret.json`);
     `apikey`, `api_key`, `api-keys`, `access-key`, `access_key`, `keyfile` and
     `oauth_token` (`api_keys.json`, `aws_access_key.csv`); `password` or `passwords` as a word
     (`passwords.csv`, `Chrome Passwords (1).csv`, `passwords-export.csv`); `credential`, `creds`, and as
     words anywhere in the name `secret(s)`, `private_key`, `secret_key` and `access_token`, `auth_token`,
     `api_token`, `github_token`, `bearer_token`, `refresh_token`, `id_token` (`app_secrets.json`,
     `access_token.json`); password-manager exports: `bitwarden`, `lastpass`, `1password`, `keepass`,
     `dashlane` as words (`bitwarden_export.json`), and `logins` and `keystore` as the whole name, `.csv` or `.json`,
     with what a second download or a copy adds (`logins (1).csv`, `logins-2026-10-16.csv`,
     `logins_backup.json`; a wallet's or a login's ledger, `wallet_transactions.csv`, is not refused);
     `local.settings.json` (Azure Functions) and `.docker/config.json`; `accesstokens` (`accessTokens.json`);
     `token.json`, `tokens.json` and `auth.json`; `key.json` and names ending `-key.json`, `_key.json`
     or `.key.json` (`sa-key.json`); and a Google Cloud key as
     downloaded, `<project>-<12 hex digits>.json` with at least one letter among the digits (so a
     timestamp such as `export-202401011230.json` is not one). A word is bounded by anything but a
     letter or digit (a space, a bracket, `-`, `_`, `.`), and a space may join a two-word name
     (`Bitwarden Export.json`, `Secrets (1).json`, `api key.json`); a camelCase word is a word too
     (`awsCredentials.csv`), and a copy's ` (1)`, ` - Copy`, ` - Copy (2)`, ` copy`, ` copy 2` before the extension, or `Copy of `
     before the name, is left out (`token (1).json`, `key - Copy.json`, `Copy of key.json`,
     `myproject-1a2b3c4d5e6f (1).json`). The same words in another name, such as
     the migration `0002_create_access_keys.sql` or the folder `add_service_accounts`, are not a
     secret. A name the list misses is not refused: the list covers the usual downloads, not every one.
     Some ordinary ledger names are refused too, and must be renamed: `service_account_statement.csv`,
     `tokens.json`, `secret_santa_ledger.csv`, `password_reset_fees.csv`, and an id of 12 hex digits after a dash
     (`stripe-balance-1a2b3c4d5e6f.json`); `credentialing_fees.csv` is not. And a file the list misses
     can be read through the ledger tool, page by page. The caller chooses the mapping, so one call can
     show any three columns of every row (mapped as the id and as two of amount, side, debit, credit
     or currency, echoed through `BAD_AMOUNT`, `BAD_SIDE` and the nets of `UNBALANCED`), 40
     characters each, and a few calls every column. `COLUMN_NOT_FOUND` lists up to 30 cells of the
     first line, 40 characters each: in a file with no header, they are data. And `file_sha256`, the
     hash of the whole file, lets a model check a guess at a short secret file's content.
   - anything inside `.git/`
   - ledger-type files inside a folder where command-line tools keep logins: `.aws`, `.azure`,
     `.gcloud`, `gcloud`, `.kube`, `.ssh`, `configstore`, `legacy_credentials`; and token files by name
     (`gmail-token.json`, `token_cache.json`, `mycreds.json`)

   This is defence in depth. The tools echo only tiny pieces of a file, but a read-only tool must
   never become a way to read secrets.

Paths in results are relative to the root and use `/`. Error messages name the root by its folder
name only, never its absolute path.

The same rules hold for every link `money_lint_schema` meets while it walks a migrations folder: the
real target must exist (`PATH_NOT_FOUND`), lie inside the root (`PATH_OUTSIDE_ROOT`) and not look like
a secret (`SENSITIVE_PATH`), and a link named `*.sql` must lead to a `.sql` file
(`FILE_TYPE_NOT_ALLOWED`). Otherwise a hostile repository could ship `db/migrations/0002.sql` linking
to `../../.env` and have the secrets run as SQL. A `.sql` file named like a secret (`.env.local.sql`)
is refused the same way (`SENSITIVE_PATH`): a migration is never left out in silence. Other secret
files in the folder, and `.git`, are skipped, as they are not migrations.

**Out of scope:** a local attacker who can swap symlinks between the check and the read (they could
already read the files).

### 2.4 What a successful result looks like
- `structuredContent`: a JSON object that the SDK validates against the tool's `outputSchema`. Plus
  one text block holding the same JSON (compact), as the spec recommends.
- The first field is always `summary`: a short plain summary (a few sentences) for the model
  and for people. The fields come
  in the order of the output tables below, so every result reads the same way.
- **Size budget: at most 20,000 characters per result.** That is well under Claude Code's
  50,000-character file threshold and its 25,000-token cap. Long lists are capped or paginated, and
  each cap is reported (`..._truncated`, `next_offset`). The caps keep results small with ordinary
  names. If very long names or locations still push a result over the budget, the tool shortens its
  least important lists until it fits:
  - `money_lint_schema`: first `files_applied`, then `other_float_columns`, then `findings` (never
    below one). The counts still cover everything, and the `..._truncated` flags and `other_float_columns_count` say what was cut.
  - `money_check_double_entry`: a shorter page (never empty). `next_offset` continues from the first
    finding left out, so paging still reaches every finding it keeps (the first 10,000, §4.8).

  Each field that can be long is bounded first, so one finding always fits. As a last guard, the
  server never sends a result over the budget: should a tool's own shortening ever fail, the model gets
  `INTERNAL_ERROR` and the log says `OverBudgetError`.
- **Money values are strings of integer minor units** (`"-150"`). That is exact at any size; sums use
  `BigInt`. No floating point touches an amount, anywhere.
- **Data minimisation.** A value copied from a data file into a result (a ledger cell, a header name,
  a transaction id, a currency) is cut at 40 characters, `…` marking the cut (a `…` in the value
  itself shows as it is, so a value that holds one may look cut). A few things are cut at
  other lengths, among them: a JSON parse error at 60, the project root's folder name, a placeholder
  setting and a `records_pointer` at 80, a `money_columns` or `ignore_columns` entry at 80 or 120, a log entry's `writer_key_id` at 64, a library reason at 120, a finding's `message` at
  120, a Postgres error message at 300 (it can quote the migration's own text, such as a path the
  migration names) and its detail at 120 (it can quote a row's values, as a unique-key violation does),
  the reason a lint database stopped at 200, the one header or field name `COLUMN_NOT_FOUND` suggests at 200 (the list beside it cuts each name at 40, and the model needs the whole name to map it), and a CSV header read as one column is shown up to 40 characters, though that can
  be all of a short file's first line. Database table and column names stay whole, so the model can act on them
  (PostgreSQL caps a name at 63 bytes). A column's type is cut at 200 characters: PostgreSQL's
  `format_type` writes it, and a migration can replace that function. A path inside the project stays whole up to 400 characters; a
  longer one (folders can nest deep) is cut in the middle with `…`, keeping its first folders and its
  file name, so one finding or one error always fits the budget. A result never holds key material.
  (A value can still be up to 40 characters of a file that holds a key: the tools refuse the files
  named in §2.3, and cannot know what every other file holds.)
- **Hidden characters are always escaped,** by Unicode category: controls (Cc); format characters (Cf:
  zero-width characters, direction marks, the bidirectional overrides and isolates of "Trojan Source",
  which make text read differently from what it is, the byte order mark, and the TAG characters, which
  can spell out text a person cannot see but a model reads); line and paragraph separators (Zl, Zp);
  lone surrogates (Cs); private-use characters (Co) and code points with no character (Cn), which show
  as nothing or a box; the other default-ignorable code points (variation selectors, the Hangul and
  Mongolian fillers); and four characters drawn blank that no category gives away (U+2800, U+16FE4,
  U+13440, U+1D159). Each appears as `\uXXXX`, or `\u{XXXXX}` above U+FFFF, in every result and
  error money-guard writes: each tool escapes what it copies, and the server escapes every result and
  error once more on the way out. In text copied from a project or a file, every backslash appears
  doubled in the text (so as four in the JSON on the wire): a single backslash always starts an
  escape, so no two texts look alike. `fix_sql` is the exception: it is SQL to run, so it keeps a
  name's backslashes single, and is null for a name that holds a backslash before `u` (§3.6).
  Where a result or an error puts copied text in double quotes, a double quote inside it appears as
  `\"`, so the text cannot close them (a value shown without quotes keeps its own).
  The six characters `\u200b` show as `\\u200b`, a backslash followed by a real U+200B as `\\\u200b`,
  and `\\u200b` typed as text as `\\\\u200b`. Other
  blank-looking characters, such as wide spaces, are ordinary text and appear as they are. (Text the SDK writes itself, such as an input validation error that
  quotes the model's own argument, is not money-guard's.) Names that hold such characters get no
  `fix_sql` (§3.6).
- **Deterministic.** The same files and the same arguments give byte-identical results on the same
  Node.js version (which characters have no character, Cn, follows that version's Unicode). Findings are
  sorted; there are no timestamps, durations or random ids. The tests rely on this, and so will the
  planned agent evaluation, which will cache results.
- An optional parameter sent as `null` means "not given". Models sometimes send `null`, which zod's
  `.optional()` alone would refuse. A test proves it (§7).

### 2.5 Errors
- **Tool errors:** a result with `isError: true` and one text block: `CODE: what went wrong. Fix: what
  to do.` It has no `structuredContent` (the SDK skips output validation on errors). The code comes
  first, so a program can read it.
- **Protocol errors:** only for unknown tools and malformed requests (the SDK sends these).
- **Arguments that break the input schema** come back from the SDK as an `isError` result ("Input
  validation error: ...", or in other words of its own, as for more than 2,500 elements) before our
  handler runs. Every input object is strict (unknown keys are refused; the SDK drops a `__proto__` key at the top level, and refuses one inside `columns` as an unknown key), so a misspelt parameter name is reported instead of silently ignored. That text comes from
  the SDK, does not start with a money-guard code, and is not held to the size budget of §2.4.

Shared error codes:

| Code | When | Fix the message suggests |
|---|---|---|
| `ROOT_INVALID` | The root is missing, cannot be listed or entered (permission denied), is not a folder, or is a filesystem root. | Set `MONEY_GUARD_ROOT` to the project folder. |
| `PATH_INVALID` | Empty, too long, NUL, a device/UNC path, or (on Windows) a colon anywhere but after a drive letter, which names an alternate data stream. | Pass a path relative to the project root. |
| `PATH_OUTSIDE_ROOT` | Resolves outside the root (including through a symlink). | Use a path inside the project. On Windows, for a path that starts with one `/`, it adds that such a path begins at the root of the drive: Git Bash paths (`/c/Users/...`) are not understood. |
| `PATH_NOT_FOUND` | Nothing at that path. | Names the nearest existing parent folder. |
| `NOT_A_FILE` | A folder where a file is needed, or something that is neither a file nor a folder. | Says which one the tool expects. |
| `FILE_TYPE_NOT_ALLOWED` | The extension is not in the tool's list. | Lists the allowed extensions. |
| `SENSITIVE_PATH` | Matches the secrets list in §2.3. | The tools never read secret files. |
| `FILE_TOO_LARGE` | Over the tool's size limit. | States the limit; suggests a smaller export. |
| `FILE_UNREADABLE` | The file or folder passed the checks but cannot be read: another program has it locked (Windows), permission is denied, or it went away. | Locked: close the program that holds it. Permission denied: give the user that runs the server read access, and read and search (x) access to each folder on its path. Gone: check the path. Then call again. |
| `BUSY` | A second `money_lint_schema`, or a ledger or audit check, while a lint runs (§2.6). | Retry after the running lint finishes: usually a few seconds, at most its time limit. |
| `INTERNAL_ERROR` | A bug, or a lint database that cannot start (a broken install: the fix says to reinstall first). | Details are in the server's log (stderr). |

### 2.6 Limits and concurrency
- At most **one** `money_lint_schema` runs at a time, because it starts a database: a second one gets
  `BUSY` straight away, with no hidden queue. (The MCP spec says servers MUST rate-limit tool calls.)
  While a lint runs, `money_check_double_entry` and `audit_verify_chain` answer `BUSY` too: each holds
  the main thread for seconds, and the lint's memory limit (§3.9) is checked on that thread, so a
  hostile migration could grow by gigabytes before it was stopped. Once the lint has answered, they run.
- `money_check_double_entry` and `audit_verify_chain` run to the end before the server reads the next
  message, so they answer one call after another; on the largest files they allow (25 and 100 MiB)
  that can take several seconds: 2 to 4 for a million-row CSV ledger and about 4 for a 100 MiB audit log on
  an ordinary machine, more on a busy one. A hostile file cannot make the ledger tool take much longer
  or fill memory: it keeps the first 10,000 findings (counting all), reads a CSV row of at most 1 MiB
  of values, and a JSON file of at most 7,000,000 values and 100,000 different keys (§4.8).
- A cancelled lint stops its work: the worker is terminated and its database discarded, the log gets
  a `CANCELLED` line, and the next lint can start at once (its database starts once the cancelled
  one's thread has ended, §3.4). A ledger or audit call cannot be cancelled
  once it has started: a cancel that arrives while it runs is read only after it has ended, so the
  call is answered and logged `ok`. It ends within those seconds. A cancel that arrives with the call
  (in the same read) is read first, and the call does not run.
- Each tool's own limits are in its section.

### 2.7 How the tools are shown to the model
- Order: `money_lint_schema`, `money_check_double_entry`, `audit_verify_chain`. It never changes, and
  the tool list never changes: the capabilities say `tools.listChanged: false`, and in the 2026-07-28
  era `tools/list` says it may be kept a day (`ttlMs` 86,400,000, `cacheScope` public).
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
  >   edited, reordered or forged, and, given the head an earlier run returned, that none was cut off.
  >
  > Paths are relative to the project root; if you cannot list the project's files, ask the user for
  > the path. Run money_lint_schema on its own: while it runs, the other tools answer BUSY. Fix schema findings with a NEW migration; never edit migrations that may
  > already have run. Never repair or re-seal an audit log that fails verification: report it.

### 2.8 Dependencies
| Package | Why | Licence |
|---|---|---|
| `@modelcontextprotocol/server` ^2.3.1 | MCP server, both eras | Apache-2.0 |
| `zod` ^4.6 | Schemas (SDK v2 needs ^4.2) | MIT |
| `@electric-sql/pglite` **0.5.9 exactly** | PostgreSQL 18.6 in WebAssembly for tool 1 (its version appears in results) | Apache-2.0 |
| `@electric-sql/pglite-pgvector` **0.0.10 exactly** | `CREATE EXTENSION vector` (common in AI apps) | Apache-2.0 |
| `sealed-audit-chain` | Tool 3. Comes from npm once published; until then `github:Spundu/audit-chain#5fd1fec` | MIT (same author) |
| `csv-parse` ^7 | RFC 4180 CSV with line numbers | MIT |

Dev only: `@modelcontextprotocol/client` (the tests and the README demo), typescript, vitest with
vite, eslint with `@eslint/js` and typescript-eslint, and `@types/node`.
Fetched by npm when needed, pinned: the mcpb CLI (`@anthropic-ai/mcpb` 2.1.2, by `npm run bundle`) and
the MCP Inspector (2.11.0, by `scripts/inspector-smoke.sh`). The planned agent evaluation (not built
yet) will use `@anthropic-ai/sdk`.

### 2.9 Stability promise
Tool names, parameter names, output field names, finding codes and error codes are public API. A
**major** version is needed to change or remove one. A minor version may add a code or a field.

---

## 3. Tool 1: `money_lint_schema`

**Where it comes from:** a check script in one of the author's apps ran a regex over the SQL; this tool
runs the SQL instead. That is the lesson of
[verification-instruments](https://github.com/Spundu/verification-instruments), whose regex SQL provers
never converged: verify by executing, not by parsing.

### 3.1 Description (exact, shown to the model)
> Find database columns that store money unsafely. Runs the project's SQL migrations in order inside a
> throwaway in-memory PostgreSQL 18 (PGlite), then reads the real column types from the catalog, so
> the result is what Postgres actually built, not a guess from the SQL text. Reports money columns
> (names like price, amount, total, fee, balance, *_pence) stored as real/double precision (floats lose
> pennies) or as the money type (errors), and as numeric or smallint (warnings), each with the migration
> file that introduced it and, where the conversion is clear, an ALTER statement to fix it. Read-only: never connects to a real database
> and never changes files. Fix findings by adding a NEW migration, then run this tool again: it runs
> your fix too. If a migration fails because it needs objects your platform provides (Supabase roles,
> auth schema), pass preset or setup. Findings come at most 50 at a time: for more, pass the next_offset the
> result gives as offset.

### 3.2 Input
| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `migrations` (required) | string, a path | | A folder of `.sql` migration files, or one `.sql` file (for example a `pg_dump --schema-only` file). |
| `files` | array of 1-2,000 paths, relative to `migrations` | every `.sql` file under the folder, in natural order (§3.3) | Run exactly these files, in this order. Use it when your tool orders migrations differently (Flyway `V…`/`R…` names, sqitch plans). Every entry must exist inside the folder. |
| `preset` | `"supabase"` | none | Built-in setup for Supabase projects (§3.4). |
| `setup` | string, a `.sql` path relative to the project root | none | A file run before the migrations (after `preset`), to create what your platform provides: roles, schemas, functions. Columns it creates are not checked. If it lies in the migrations folder, it is not run again as a migration. |
| `accept_numeric` | boolean | `false` | Treat `numeric`/`decimal` money columns as fine instead of warning about them. |
| `money_columns` | array of ≤ 200 names (3-200 characters each) | none | Extra columns to treat as money: `"table.column"` (schema `public`) or `"schema.table.column"`, written as the database has them (a result shows a backslash doubled: write it once). A name that holds a dot cannot be listed. |
| `ignore_columns` | array of ≤ 200 names (3-200 characters each) | none | Columns never to report (false positives), in the same format. The findings they would raise still count in `ignored_count`. |
| `offset` | integer ≥ 0 | 0 | The first finding to return: the `next_offset` of the previous result. Each page runs the lint again, and the same files give the same findings in the same order. |
| `timeout_seconds` | integer 5-300 | 45 | Stop after this long. The default stays under the 60 seconds a client built on the MCP TypeScript SDK waits by default (its `DEFAULT_REQUEST_TIMEOUT_MSEC`, 2.3.1), so the model gets `TIMEOUT` with the file that was running, not a client error. A larger value only helps with a client that waits longer, as some can be set to (Claude Code's `MCP_TOOL_TIMEOUT`). |

### 3.3 Which files run, in which order
- **Default:** every `*.sql` file under `migrations`, at any depth, except files that only undo
  migrations: `down.sql` and `*.down.sql` (golang-migrate, Diesel), `*.undo.sql` (Postgrator) and
  `*.rollback.sql` (yoyo).
- **Natural order** of the relative paths. Paths are compared folder by folder. Runs of digits compare
  by numeric value; everything else compares by character code. So `V2__x` comes before `V10__x`,
  `0001_a` before `0002_b`, and `20240101_x/migration.sql` before `20240202_y/migration.sql`. That
  ordering fits Drizzle, Prisma, Supabase, golang-migrate, goose, sql-migrate, node-pg-migrate SQL,
  dbmate, Atlas and Diesel.
  Anything else passes `files`. The result lists the files it applied, so the order can be checked.
- **File-format markers are honoured.** They are lines written by tools, matched by line, not SQL
  syntax, so the "never parse SQL" rule still holds:
  - **Up and down in one file:** the down part is left out, from a line that starts it to the next
    line that starts an up part (or the end). The markers are the ones the tools write: dbmate
    `-- migrate:up` and `-- migrate:down` (alone, or followed by options), goose `-- +goose Up` and
    `Down`, sql-migrate `-- +migrate Up` and `Down`, node-pg-migrate `-- Up Migration` and
    `-- Down Migration` (as its own parser reads them: indented, or with more dashes), and tern
    `---- create above / drop below ----`. A down marker counts only in a file that also holds its
    tool's up marker (tern has none), so a comment such as `-- Down migration (manual)` in an ordinary
    file cuts nothing. A file that holds comments reading as both node-pg-migrate markers (`-- up
    migration notes`, later `-- down migration is manual`) is cut as node-pg-migrate's own parser
    would cut it. The down part becomes blank, so line numbers stay exact. Without this, the down
    part would drop what the up part created, and the lint would see nothing to check.
  - **pg_dump 17.6+/18:** lines starting `\restrict ` or `\unrestrict ` are blanked, keeping the same
    length, so line numbers stay exact.

  Any other psql meta-command (a line starting `\`) fails with a hint. If no table exists after the
  files ran (a format with an unknown down marker, say), the summary says that nothing was checked.

### 3.4 How it works
1. Check the paths, list the files and check the limits (§3.9).
2. Start a **worker thread** holding a fresh in-memory PGlite (PostgreSQL 18.6). Every extension PGlite
   bundles is registered, plus pgvector, so `CREATE EXTENSION` works for: amcheck, autoinc, bloom,
   btree_gin, btree_gist, citext, cube, dict_int, dict_xsyn, earthdistance, file_fdw, fuzzystrmatch,
   hstore, insert_username, intarray, isn, lo, ltree, moddatetime, pageinspect, pg_buffercache,
   pg_freespacemap, pg_stat_statements, pg_surgery, pg_trgm, pg_visibility, pg_walinspect, pgcrypto,
   plpgsql (installed already, as in every PostgreSQL), refint, seg, tablefunc, tcn, tsm_system_rows,
   tsm_system_time, unaccent, uuid-ossp and vector. The database lives in memory and sees only a **virtual filesystem**: a migration cannot read
   or write the computer's files or run programs (§1, fact 6). The worker's output (a NOTICE a
   migration raises, say) is captured and dropped, so it never reaches the protocol channel or the log.
3. Run `preset` (if given), then `setup` (if given). Then take a **baseline snapshot** of the catalog.
   Columns already present at that point are not checked, unless a migration changes their type
   (`real` and `double precision` count as one type here: both are floating point, so a setup
   column changed from one to the other stays unchecked).
4. Run each migration file as **one script**. PostgreSQL runs a multi-statement script as one
   transaction, so a file behaves as `psql -1 -f` would (`psql -f` alone commits statement by
   statement): a file that adds a value to an enum an earlier file created, then uses it, fails
   (SQLSTATE 55P04, with a hint), as does `CREATE INDEX CONCURRENTLY` beside other statements (25001;
   alone in its file it runs). After each file:
   - run a **sanity query** (`SELECT 1`, with its own 5-second limit). A file that leaves the database
     unusable or silent (for example `COPY ... PROGRAM`, which PGlite cannot run) fails as
     `MIGRATION_FAILED` for that file. An answer that came while the server's main thread was busy
     still counts: the server reads the messages waiting for it before it calls the database silent.
   - take a **snapshot** of the columns the file created or changed, with their types: any change to
     a column rewrites its catalog row, which then carries the file's transaction id, newer than a
     mark taken just before the file. Reading only those keeps a folder of hundreds of files from
     reading every column after each one (802 files of an 800-table schema: 6.7 s, where reading
     every column took 16.6 s, and ran out of time on a busy machine).
   - Column identity is the table's internal id plus the column number, so renaming a table or a
     column does not lose track of it.
   - A file that fails stops the run. Postgres rolls that file back as a whole.
5. Once every file has run, **read the catalog** and classify the columns of every **ordinary and
   partitioned table** in non-system schemas. Excluded:
   - views
   - partitions (reported once, through their parent)
   - inherited columns (reported where they are defined)
   - tables created by extensions

   The read gathers each column's defaults, CHECK constraints and unique-index conditions once per
   table and column name, so its cost grows with the size of the schema (a 400-table schema reads in about
   0.3 s on the test machine, under the test's 4 s ceiling). The worker says first that it is reading: a time limit or the memory limit hit
   there says so, not that the last file was running, and a read that fails (after a migration
   replaced one of PostgreSQL's own functions that it uses, say), or that returns a value of the wrong
   kind (such a function returning NULL: every row is checked on the main thread), is
   `MIGRATION_FAILED` for the last file: "the catalog could not be read after this file, the last one".
6. For each finding, `introduced_in` is the earliest file after which the column has had its current
   type without a break. A change of precision or length (`numeric(10,2)` to `numeric(12,2)`, or `real`
   to `double precision`) is not a break. Examples:
   - created as float in `0001`, still float → `0001`.
   - created as numeric in `0001`, altered to float in `0005` → `0005`.
7. The worker is terminated when the lint ends (it has its answer, fails, runs out of time or is
   cancelled), and the database is discarded. Catalog queries name every object with its schema
   (`pg_catalog.`), so a migration that changes `search_path` cannot change what they read.
8. **One database thread at a time.** The lint answers at once, but the next lint's worker starts only
   once the last one has ended (a fraction of a second after it was told to). On Node.js 24, a thread
   with WebAssembly that starts while another is being torn down can make V8 abort the whole process
   (§1, fact 7), and the server would end with it. This makes that rare; it does not rule it out. The tests keep to the same rule: SQL that a test runs
   itself goes through the same path (`test/support/sql.ts`), never PGlite on the test's own thread
   beside lints. A lint that waits for the last thread keeps its time limit (counted from the call:
   `TIMEOUT` "while starting the database") and its cancel, so a thread that never ended would cost
   the next lint a `TIMEOUT`, not a hang.

**Supabase preset** (in v1, decided 2026-10-14; the SQL is `src/lint/supabase.ts`) creates the objects
ordinary Supabase migrations use:
- roles `anon`, `authenticated`, `service_role` (BYPASSRLS), `authenticator`, `supabase_admin`,
  `supabase_auth_admin` and `supabase_storage_admin`
- schemas `auth`, `storage` and `extensions`, with `uuid-ossp` and `pgcrypto` installed in
  `extensions` and `extensions` on the search path, as Supabase has them
- table `auth.users` (its usual columns: `id uuid primary key`, `email`, `raw_user_meta_data jsonb`, ...)
- functions `auth.uid()`, `auth.role()`, `auth.jwt()` and `auth.email()`, which read the
  `request.jwt.claim` settings as Supabase's do
- tables `storage.buckets` and `storage.objects` (with row level security on), and functions
  `storage.foldername()`, `storage.filename()` and `storage.extension()`
- publication `supabase_realtime`

That covers RLS policies `TO authenticated USING (auth.uid() = user_id)`, grants, `CREATE EXTENSION ...
WITH SCHEMA extensions`, `uuid_generate_v4()` defaults, foreign keys to `auth.users`, storage
buckets and policies, and `ALTER PUBLICATION supabase_realtime ADD TABLE`. A full `supabase db dump` still fails on
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
word**, with these refinements:
- **"per":** only the words before "per" count, because the rest says what the amount is for:
  `price_per_month` and `cost_per_hour` are money; `tax_rate_per_year` is not. A name that still
  ends in a ratio word (percent, percentage, pct, rate, ratio, bps, factor, multiplier, score, share,
  split) is not money: `fee_per_txn_bps`, `commission_per_sale_pct`.
- **Rates that are prices:** "rate" after hourly, daily, nightly, night, weekly, pay, day, bill, billing,
  labor, labour, room, overtime, mileage, rental or hire is the price of an hour, a stay or a mile, so
  money: `hourly_rate`, `room_rate`; so is "rate per" an hour, day, night, week, month, mile, km,
  unit, item, kg, lb, person, guest, visit or session (`rate_per_hour`). Other rates (`tax_rate`,
  `exchange_rate`, `rate_per_second`) are not.
- **"value"** after order, orders, cart, basket, invoice, contract, deal, transaction, purchase, sale,
  sales, voucher, coupon, gift, card, item, lifetime, portfolio, inventory, stock, trade, loan, asset,
  assets, claim, policy, market, book, fair, face, par, line, net, gross or total is what that is
  worth, so money (`order_value`, `market_value`). Other values are not.
- **An amount "in" a currency:** a name that ends in currency or ccy after "in" is judged by the words
  before "in": `debit_in_account_currency` is money; `amount_currency` and `payment_method_currency`
  are not.
- **Units:** unit and units are non-money last words (`net_units`), except after minor, smallest or lowest,
  where they name the unit of an amount (`amount_minor_units`, `amount_in_smallest_unit`), and after
  price or cost, where they make a unit price (`price_unit`, Odoo's price on every order line).
- **Generic money words:** total, net, gross, credit, charge, principal and interest also start many
  measures (`total_co2`, `net_change`, `credit_utilization`, `interest_coverage`). When they are
  the only money words, the name is money unless a word after the last of them is a measure: a
  non-money last word (except unit or units after minor or smallest) or one of the measures after
  generic money words (lists below). `total_paid`, `total_deposited`, `net_ytd`, `credit_used`
  and `total_minor_units` are money; `total_co2` (co and 2), `total_tokens` and `net_units` are not.
  Words not in the lists count as money: a missed money column gets no warning at all, while a
  measure taken for money gets a finding someone can dismiss. But such a name is money only by a
  guess when a word after the generic word, or before it, is not a money, beside, unit or currency
  word (`total_passengers`, `net_ytd` and `water_total`), and so is a folded name
  that cannot be split into known words and has total at one end (`totalco2`): its finding has `fix_sql` `null` unless the
  column is listed in `money_columns` (§3.6), so a measure is never multiplied by 100. Before total or totals, a count or a
  measure says what is totalled, so the name is not money: `weight_total`, `hours_total` and
  `credit_score_total` are read as `total_weight`. These words are the counts and the rates and
  measures among the non-money last words, the plural time words (days, nights, weeks, months, years,
  hours, minutes, seconds) and ms, and the measures after
  generic money words; not unit, units, margin or current, and not order words or things that have a price
  (`units_total`, `margin_total`, `line_items_total`, `orders_total` and `tier_total` are money,
  some as guesses). A count or measure after another money word does so too (`fee_count_total` counts
  fees), but not one before it (`energy_cost_total` is a total of costs). Other
  generic words keep theirs: `usage_charge` is money.
- **Folded names:** PostgreSQL folds unquoted names to lowercase, so `TotalAmount` arrives as
  `totalamount`. Every word the rule does not know is first split into the words it knows (the money,
  non-money, unit, currency, ratio, rate, value and beside lists, all in this section), in as few words as
  it can be: `totaldiscount` is total + discount, `platformfee` platform + fee, `totalqty` total +
  qty, and a folded word inside a longer name too: `totalamount_old` is total + amount + old. The split
  name gets the answer its snake_case form gets, for the minor-unit words too (`amountminorunits`,
  `pricecentsusd`: `fix_sql` only rounds). A number at the end is dropped (`price2`,
  `credit_card_last4`). A one-word name that cannot be split into known words still counts when it
  ends in a long money word (amount, balance, cost, payment, payout, price, refund, revenue, salary,
  subtotal, surcharge, total), maybe followed by a minor-unit word (below, except the short cent, sat
  and wei), or starts with one and does not end in a non-money word of four letters or more. Words
  that would also split ordinary words into money words ("work": network) are not in the lists, so
  coffee, syntax, network and discharge stay what they are.
- **"minor"** says the unit of an amount beside another money word (`amount_minor`,
  `amount_minor_units`). Beside a version it is a version part (`version_minor`, `os_minor`); alone,
  or with unit (`minor_unit`, ISO 4217's currency exponent), it is not an amount.

The word lists:
- **Money words:**
  - common: amount, amounts, amt, balance, balances, charge, charges, cost, costs, discount, discounts,
    fee, fees, money, payment, payments, payout, payouts, pence, penny, pennies, cent, cents, paise,
    minor, price, prices, refund, refunds, revenue, salary, salaries, subtotal, surcharge, tax, taxes,
    total, totals, vat, wage, wages, gbp, usd, eur
  - ledger and finance: debit, debits, credit, credits, net, gross, commission, commissions, deposit,
    deposits, interest, principal, expense, expenses, income, profit, profits, earnings, budget,
    budgets, msrp, mrr, arr, mrp, gst, cgst, sgst, igst
  - pay, commerce and insurance: bonus, bonuses, allowance, allowances, stipend, stipends, diem, rent,
    rents, fare, fares, spend, premium, premiums, deductible, deductibles, donation, donations, penalty,
    penalties, pnl, cogs, shipping, tip, tips, pay, cashback, copay, copays, reimbursement,
    reimbursements, installment, installments, instalment, instalments, dividend, dividends, royalty,
    royalties, arrears, overdraft, overdrafts, payable, payables, receivable, receivables, spending,
    contribution, contributions, proceeds, postage, rrp, cash, gmv, aov, arpu, notional, emi, bal,
    deduction, deductions, markup, markups, gratuity, gratuities, duty, duties, excise, tariff, tariffs,
    brokerage, freight, toll, tolls, ltv, ebitda, severance, debt, debts
  - minor units of other currencies: paisa, kobo, sats, satoshi, satoshis, centavo, centavos, kopek,
    kopeks, kopeck, kopecks, wei, lamport, lamports, msat, msats
- **Generic money word list:** total, totals, net, gross, credit, credits, charge, charges, principal,
  interest
- **Measures after generic money words:** co, ghg, carbon, emissions, reps, carbs, protein, fat, sugar,
  latency, memory, cpu, ram, disk, storage, bandwidth, tokens, errors, failures, requests, calls,
  events, messages, downloads, files, tasks, jobs, runs, tests, cases, deaths, population, words,
  chars, characters, likes, followers, rainfall, change, changes, flow, flows, utilization,
  utilisation, component, components, coverage, axis, investigator, meters, metres, liters, litres,
  tons, tonnes, grams, mass, force, torque, heat, flux, runtime, uptime, xp, damage, mins, hrs, secs,
  kw, mb, gb, bmi, goals, wins, players, mileage, current, voltage, amps, watts
- **Words beside money words** (known for splitting folded names):
  platform, service, late, sales, sale, base, retail, wholesale, delivery, handling, processing,
  booking, cancellation, setup, transfer, exchange, monthly, annual, yearly, initial, final, original,
  max, min, limit, due, paid, owed, outstanding, remaining, pending, grand, line, item, order, invoice,
  account, opening, closing, current, available, card, per, in, value, after, before, smallest, lowest,
  denomination, unit,
  old, new, prev, previous, holiday, sick, overtime, take, home, sub, cart, basket, running, store, refunded, invoiced, charged, billed, spent, earned, collected, withdrawn, deposited, accrued, credited, debited, settled, disbursed, reimbursed, received
- **Non-money last words:**
  - identifiers and labels: id, ids, uuid, key, ref, code, currency, ccy, type, kind, status, state,
    method, mode, reason, note, notes, description, desc, label, name, title, text, url, hash, flag,
    enabled, version, address, carrier, class, intent, transaction, transactions, subnet, subnets
  - dates and times: date, at, on, time, ts, timestamp, year, years, month, months, week, weeks, day,
    days, night, nights, hour, hours, minutes, seconds, ms
  - counts: count, number, num, qty, quantity, attempts, retries, unit, units, rooms, seats, shares,
    guests, users, members, customers, people, persons, visits, views, clicks, impressions, sessions,
    bytes, pages, rows, hits
  - order, and things that have a price: no, items, rank, ranks, tier, tiers, level, levels, band,
    position, priority, index, seq, sequence, step, steps, stage, stages, orders, records, lines, last,
    first, frequency, grade, schedule, cycle
  - rates and measures: percent, percentage, pct, rate, ratio, bps, factor, multiplier, weight, score,
    share, split, distance, duration, km, kg, g, mg, kwh, volume, points, votes, miles, ml, margin, elasticity,
    calories, kcal, energy, lb, lbs, rating, ratings, tonnage, area, size, length, width, height, depth,
    power, usage, capacity, speed, temperature, precision, scale, growth
  - groupings and terms: category, categories, list, lists, center, centre, terms, period
- **A balance, budget or allowance of something else** is not money: a count or measure word, or one
  of leave, holiday, holidays, pto, vacation, sick, error, baggage, luggage, mass, fluid, calorie,
  token or point, between the last balance, budget or allowance in the name and the money word before it,
  with no money word after it (`hours_balance`, `holiday_allowance`, `error_budget`,
  `leave_balance_remaining`, the folded `leavebalance`; `account_balance`, `travel_allowance` and
  `balance_after` are money). With stock, inventory or data there it may be either (an inventory
  balance is money in accounting), so it is money by a guess: a finding with a null `fix_sql`. A
  budget is money unless the word before it is of computing or time (latency, cpu, memory, tokens,
  errors, hours: `latency_budget`); `holiday_budget`, `stock_budget` and `growth_budget` are money,
  and `data_budget` is a guess.
- **Minor-unit words** (`fix_sql` only rounds; the word right after "per" does not count, as it says
  what the amount is for, as in `price_per_cent`, but a unit word after that does: `price_per_unit_cents`
  is in cents, and `cost_per_click_micros`, `price_per_unit_kwd` and `price_per_month_minor_units`,
  whose unit word there is unsure, give `null`; before the money
  word only pence, cents and pennies do: `subunit_price` or `kobo_price` may name a product or a brand,
  so the unit is unsure; "minor", "smallest" or "lowest" before unit, units or denomination count only
  when no money word follows, as `lowest_unit_price` is a product's unit price): pence, penny, pennies, cent, cents, paise, paisa,
  kobo, sats, satoshi, satoshis, centavo, centavos, kopek, kopeks, kopeck, kopecks, wei, lamport,
  lamports, msat, msats, subunit, subunits, pesewa, pesewas, halala, halalas, fils, agora, agorot,
  centime, centimes, rappen, grosz, groszy, stotinka, stotinki, santim, santims, kurus; and "minor",
  "smallest" or "lowest" before unit, units or denomination (`amount_minor_units`,
  `amount_in_smallest_unit`, `amount_lowest_denomination`).
- **Currencies without minor units** (ISO 4217 exponent 0; `fix_sql` only rounds, as whole yen are
  the smallest unit): bif, clp, djf, gnf, isk, jpy, kmf, krw, pyg, rwf, ugx, vnd, vuv, xaf, xof, xpf, yen
- **Unsure unit words** (`fix_sql` is `null`, the unit needs a decision): sat, minor, won, ore, fen,
  sen. Without unit after them they may say the unit or something else (`amount_minor`, but also
  `price_minor`, a child's price, and `price_sat`, Saturday's; `amount_won` may be Korean won or a
  prize; `total_ore` öre or iron ore).
- **Finer units** (`fix_sql` is `null`: `cost_micros` holds millionths, and a fix must choose the
  unit): micros, micro, millicents, millicent, mills, millis, gwei
- **Currencies with more than two decimals** (`fix_sql` is `null`: a dinar has 1,000 fils, so
  `amount_kwd` may hold dinars or fils, and neither takes ×100; crypto coins have 8 or 18): bhd, iqd,
  jod, kwd, lyd, omr, tnd, clf, uyw, btc, xbt, eth, sol, usdc, usdt, dai, ltc, xrp, ada, doge, bnb
- **Examples that are money:** `total`, `unit_price`, `amount_pence`, `amountMinor`, `amount_due`,
  `platform_fee`, `balance_after`, `price_per_unit`, `price_per_month`, `total_gbp`, `totalamount`,
  `amountdue`, `platformfee`, `totaldiscount`, `debit`, `credit_limit`, `net`, `hourly_rate`,
  `rate_per_hour`, `order_value`, `debit_in_account_currency`, `shipping`.
- **Examples that are not:** `stripe_price_id`, `amount_currency`, `price_updated_at`, `total_count`,
  `tax_rate`, `fee_bps`, `total_items`, `payment_method`, `minor`, `version_minor`, `total_kwh`,
  `costcenter`, `gross_margin`, `credit_score`, `fee_per_txn_bps`, `payment_intent`, `totalqty`,
  `total_nights`, `revenue_share`, `minor_unit`, `rate_per_second`.

The lists are tested against a table of about 500 column names: real ones (Stripe, Shopify, Supabase
templates, ledgers, payroll and the author's own apps), edge cases written to pin each rule (`total_2`,
`costmicros_old`), and look-alikes the rule must not
take for money (coffee, syntax, discharge), in `test/names.test.ts`. A name rule cannot know every
schema: a real money column it misses that is a float still shows in `other_float_columns`, which every
summary mentions. Names it gets wrong can be added with `money_columns` or left out with
`ignore_columns`.

### 3.6 Findings
| Code | Severity | Rule |
|---|---|---|
| `FLOAT_MONEY` | error | A money column whose base type is `real` or `double precision`, or an array of them. |
| `MONEY_TYPE` | error | Any column whose base type is `money`, whatever its name. |
| `NUMERIC_MONEY` | warning | A money column whose base type is `numeric`/`decimal`. Silenced by `accept_numeric`. |
| `SMALLINT_MONEY` | warning | A money column whose base type is `smallint`, which holds at most 32,767 minor units (£327.67). |

`integer` and `bigint` money columns are fine. Money kept in text, JSON or a composite type is not
checked in v1 (too many false positives); such money-named columns are not counted in
`money_columns_checked`, and the summary says how many there are: columns of text, JSON, a composite
or an extension's type (`citext`), not booleans, dates or other types that cannot hold an amount.

Each finding carries a `fix_sql`: a starting point for the new migration. Its names are quoted as
PostgreSQL's `quote_ident` quotes them (bare when that reads back as the same name, otherwise in
double quotes). money-guard quotes them itself, from the names in the catalog and from the list of
keywords PostgreSQL gives before any migration runs: the migrations control the lint database, and
one that redefined `quote_ident` could otherwise write the SQL the model is told to run. Its
conversion follows the name and the declared scale; the test suite runs each kind on stored rows.
- **`FLOAT_MONEY`:** `ALTER TABLE <t> ALTER COLUMN <c> TYPE bigint USING pg_catalog.round(<c> OPERATOR(pg_catalog.*) 100)::bigint;`,
  taking the column to hold pounds or dollars. When the name says minor units (a minor-unit word of
  §3.5, read as §3.5 says), it only rounds: `USING pg_catalog.round(<c>)::bigint`. PostgreSQL's
  `round` of a float rounds a half to the even number (0.125 pounds becomes 12 pence, not 13); a
  stored float rarely holds an exact half, as most decimal amounts are stored a little off.
- **`NUMERIC_MONEY`:** the same, by declared scale: 1 or 2 decimal places multiply by 100; scale 0 (or
  less) holds whole numbers, which stay as they are (`... TYPE bigint;`); no declared scale rounds like
  a float. A column finer than a minor unit (more than 2 decimal places, or any decimals on a
  minor-unit name) gets `null`: the unit needs a decision first.
- **`MONEY_TYPE`:** `... USING (<c>::numeric OPERATOR(pg_catalog.*) 100)::bigint;` (the money type holds major units, with
  the fraction digits of the database's `lc_monetary`: 2 in the lint database and most locales; check
  a database set to a locale with 0 or 3, such as ja_JP, before running it).
  `null` when the default is written as a money value (`0::money`): PostgreSQL cannot cast it to
  bigint, so the ALTER would fail.
- **`SMALLINT_MONEY`:** `... TYPE bigint;`
- **`null`** for a conversion of `FLOAT_MONEY` or `NUMERIC_MONEY` when the name is money only by a
  guess (§3.5: `total_passengers`, `water_total`) and the column is not in `money_columns`: a
  measure must not be multiplied by 100. Widening a whole-number column (`... TYPE bigint;`) is still
  offered.
- **`null`** also for domain, array and generated columns and for a column a child table inherits,
  where the fix belongs elsewhere (the domain, the expression, the parent table), and for a table or
  column name that holds hidden characters: the result shows such a name escaped, and SQL built from
  the escaped text would name a different column; and for a name that holds a backslash before `u`:
  in a result, where every other such backslash appears doubled, the SQL's single one would read as
  an escape.
- **`null`** too for a conversion that multiplies by 100 (pounds to pence, the money type) while
  something else may hold amounts of the column in the old unit, in its table or in any partition or
  inheritance child (an ALTER of the parent changes their column too): a default other than zero or
  `NULL`; a CHECK constraint that holds a number other than zero, calls a function, reads the whole row (`x.*`, as
  `to_jsonb(x.*)` does) or also uses
  another column; or a unique or exclusion index whose expression or `WHERE` clause holds such an
  amount, or also reads another column of a number type, or of one that can hold a number (an array,
  a range, a composite, jsonb; not uuid, and not text, so a text column cast to a number there,
  `WHERE amount > threshold::numeric`, is not seen) (`WHERE amount > approval_limit`, also when
  `approval_limit` is a key column of the index; a key column that no expression or `WHERE` reads does
  not count) (it decides which rows may exist together). A number in such a
  condition withholds the fix even when it is compared only with another column (`WHERE kind = 2`,
  `WHERE created_at > '2020-01-01'`): doubt withholds it. `ALTER COLUMN ... TYPE` converts the stored rows with `USING`, but
  leaves those as written: a default of 2.50 becomes 3 pence, and `CHECK (amount <= 1000.00)` a cap of
  £10. The next lint could not see that, so such a fix is not offered. A trigger or a function that
  compares the column with an amount in its body is not seen either: PostgreSQL records no link from a
  function's body held as text (plpgsql, or SQL written as a string) to a column, so the ALTER succeeds
  and such a cap becomes a hundred times lower. (A SQL function with a `BEGIN ATOMIC` body is linked:
  the ALTER fails with 0A000, and the hint says to drop and recreate it.)
  Check triggers and functions that use the column before running a fix that multiplies.

  **Offered** beside these, which hold no amount of the column:
  - a CHECK such as `amount >= 0`; digits in a name (`q1_revenue >= 0`) or a type's size
    (`0::numeric(10,2)`);
  - a two-decimal guard (`total = round(total, 2)`, `trunc(total, 2)`, `scale(total) <= 2`,
    `scale(total) < 3`), which holds for pence as it did for pounds;
  - a cast of the column to text compared with text (`price::text <> ''`), and another column cast to
    a type with no rules of its own (a unique index on `(user_id, amount, (created_at::date))`);
  - a unique index whose condition holds no amount (`WHERE deleted_at IS NULL`), and an ordinary index
    with a condition (it only decides which rows it speeds up).

  **Withheld** (`null`) beside these:
  - `scale(total) = 2`: a `bigint` has scale 0, so that guard would refuse every value; and a guard of
    fewer places, `round(total, 0)` or `scale(total) = 0`, which would stop guarding;
  - a cast of the column to a bounded type, `amount::numeric(5,2) = amount`, `amount::smallint`,
    `amount::bigint` (whole pounds only) or a text of fixed length such as `amount::varchar(5)`, which
    is a cap or a guard of whole units;
  - a cast to a type other than a number, `money`, text, bits, or a built-in type with no rules of its
    own (a date or time, `interval`, `boolean`, `uuid`, `inet`, `cidr`, JSON, `bytea`): a domain
    (`price::small_amt`) or an enum, whose own rules may bound the amount;
  - a pattern over the amount's text, `~`, `LIKE` or `SIMILAR TO`, which checks its form in pounds;
  - the price of one unit (`price_per_kwh`, `cost_per_request`, `unit_price`, `price_unit`) in a float
    or a `numeric` with no declared scale: it may hold less than a penny, which rounding would lose;
  - a default, CHECK or index expression longer than 2,000 characters, which is not read and counts as
    holding an amount; and more than 50 defaults, CHECKs or index texts of one column (counting its
    partitions and children), past which the rest are not read;
  - a money value (`0::money`) in a default, CHECK or index condition of a `money` column: such a
    value cannot work on a `bigint`, so the ALTER would fail.

When any finding of a code has a null `fix_sql`, that code's text in `fixes` ends with a sentence
that says why. If a fix fails, for example because a view depends on the column, the next lint run
shows it: the tool runs the new migration too.

### 3.7 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | e.g. "2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied." When no table exists after the files ran: "No tables exist after the 1 migration file, so nothing was checked. ..."; when every table comes from setup or the preset: "Nothing was checked: every table that exists after the 1 migration file comes from setup or the preset (a partition counts as part of its parent)." When no money column was found: "No money columns found in 2 tables. ..." ("No money columns of a number type" when money-named text or JSON columns were not checked; "left to check" when ignore_columns left none). When float columns not taken for money exist, every summary that checked tables ends: "2 other float columns (other_float_columns): check that none holds money." ("2 float columns" when no money column was found). "N money columns in M tables" counts only the tables that hold a money column. When not every finding is listed (more than 50, or cut to fit 20,000 characters), it ends: "Not every finding is listed (findings_truncated): pass next_offset as offset for the next ones." On a later page with none after it: "These are findings 51-55 of 55, the last." ("This is finding 55 of 55, the last." for one; "No findings from offset 100: there are 55." past the end; nothing when there are no findings). |
| `migrations` | string | The path as given, normalised. |
| `migrations_sha256` | string | SHA-256 over every applied file (path, NUL, bytes, in run order): what was checked. |
| `postgres` | string | `"PostgreSQL 18.6 (PGlite 0.5.9)"` |
| `files_applied_count` | integer | |
| `files_applied` | string[] | The first 30 (fewer if the result would pass its budget, §2.4), in run order, relative to the root. |
| `files_applied_truncated` | boolean | |
| `tables_checked` | integer | |
| `money_columns_checked` | integer | Money columns whose type was judged: a number type or `money`. Money-named columns of text, JSON or other types are not counted (§3.6). |
| `error_count`, `warning_count`, `ignored_count` | integer | Totals, including findings cut by the cap. |
| `findings` | Finding[] | Errors first, then warnings, then by table and column; **at most 50** (fewer if the result would pass its budget, §2.4). |
| `findings_truncated` | boolean | True when not every finding is in this result: after an `offset`, or with more to come. |
| `next_offset` | integer or null | Pass it as `offset` for the next findings; `null` when none come after these. |
| `other_float_columns` | string[] | Float columns whose names do **not** look like money (`schema.table.column`, the first 30, or fewer if the result would pass its budget), so the model can check none of them hold money. |
| `other_float_columns_count` | integer | |
| `fixes` | object | One plain explanation per code present (text in §3.10), ending with why `fix_sql` is null where it is. |

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
| `MIGRATION_FAILED` | A migration file fails, is not UTF-8, leaves the database unusable or silent, or ends inside a transaction it opened (BEGIN with no COMMIT: the files after it would run inside it); or the catalog cannot be read after the last file (§3.4). | The file; the line and column where Postgres gives a `position` (a syntax error does, and often an unknown name or schema; a missing role, a duplicate table and most other errors do not), counted in characters; the SQLSTATE and the Postgres message, in quotes, a quote inside it escaped (≤ 300 characters; it can quote the migration's own text, as RAISE EXCEPTION writes any, so it can never add a "Fix:" of its own). It adds a targeted hint by SQLSTATE. |
| `SETUP_FAILED` | The preset or the `setup` file fails, or the `setup` file is not UTF-8. | The same details; the fix speaks of the setup file, which `files` cannot leave out. |
| `NO_SQL_FILES` | The folder has no `.sql` files to run. | What it holds instead, subfolders included (the five most common file types, such as "It holds 3 .js files and 1 .ts file." or "It holds 1 .prisma file."; or "It is empty.", or "It holds folders but no files."), with the fix "Check that migrations points at the folder of migrations. Migrations written as code (Knex, TypeORM) need SQL first: drizzle-kit generate, prisma migrate diff --script, or pg_dump --schema-only."; or that it holds no migrations to run: its `.sql` files are down steps (left out) or the setup file (run once, as setup), and the same when `migrations`, or every entry of `files`, names the setup file. |
| `TOO_MANY_FILES` | More than 2,000 `.sql` files, more than 10,000 files and folders to look through for them (listing them blocks the server), or folders (or links to folders) nested more than 100 deep. | Points at the folder of migrations, or `files`; for more than 2,000 files, which `files` cannot hold either, at one schema-only dump (`pg_dump --schema-only`). |
| `FILE_NOT_IN_FOLDER` | A `files` entry is missing or lies outside `migrations`, names a file another entry names too, or `files` is given with a single `.sql` file. | For an entry that starts with the migrations folder (written from the project root), the fix says to leave out that leading folder. |
| `BAD_COLUMN_NAME` | A `money_columns`/`ignore_columns` entry is not `table.column` or `schema.table.column`, or names no column that the migration files create or change. | The entry, and the closest real column when there is one (PostgreSQL folds unquoted names to lowercase); or that the column comes from setup or the preset, whose columns are not checked. An inherited column is named by the table that defines it. |
| `TIMEOUT` | The time limit was hit. | Which file was running (or that the database was starting, or that the catalog was being read after every file had run), and the limit. The fix says to leave slow data-loading files out with `files` (the setup file: take slow data loading out of it; one migrations file: lint a schema-only copy; a folder of 300 files or more: pass a larger `timeout_seconds`, or lint one schema-only dump of the database they build; linting the files in groups would fail, as each group needs the ones before it; while the catalog was read, after every file had run: none of these), and that a limit over 60 seconds helps only with a client that waits longer than that. |

The `MIGRATION_FAILED` hints by SQLSTATE:
- **42704** (an object does not exist), **3F000** (no such schema), **42P01** (no such table) and
  **42883** (no such function): "use `preset` or `setup`". For a type it first says to check its
  spelling (`intt`). For a table, a function, a type or a schema it first says
  that the files may have run out of order (pass `files`, or, when `files` set the order, put the
  file that creates it first): such objects are often the project's own, made by a file that sorts
  later (Flyway's `R__` files sort before `V1__`).
- **42883 for an operator** (`operator does not exist: uuid = text`): "cast one side, or fix the
  column type".
- **0A000 when a column's type cannot change** because a view, a rule, a policy, a trigger, a
  generated column or a function with a `BEGIN ATOMIC` body uses it (as after a `fix_sql`): "drop it before the ALTER and create it again
  after, in the same migration".
- **A transaction left open** (BEGIN with no COMMIT): "add the COMMIT it lacks, or take out its BEGIN".
- **53200 with PostgreSQL's hint to raise max_locks_per_transaction:** "the file creates more objects
  than one transaction can hold locks for": split it (the lint database already allows 4,096 locks per
  transaction, against PostgreSQL's default of 64, so a one-file dump of thousands of tables runs).
- **42P07, 42710, 42P06, 42723** (a table, a role or extension, a schema or a function that already
  exists): "something creates this object twice", with only the causes there can be (the file
  itself; in a folder, two migrations or files out of order too; the setup file only when one is
  given, and not for the preset):
  "create it once, or with IF NOT EXISTS"; with the
  Supabase preset, that the preset already makes some objects (roles such as anon). For the public
  schema or the plpgsql language: every PostgreSQL database already has them.
- **Extension not available:** the list of available extensions, and that a whole-database dump
  (`pg_dump`, `supabase db dump`) should be linted as its migrations folder instead.
- **42601** (syntax error) on a line starting with `\`: "psql meta-command"; after a
  `COPY ... FROM stdin;` line: "a pg_dump with data; lint a schema-only dump"; otherwise "Fix the SQL
  at that place: PostgreSQL could not read it as written" (setup or a preset cannot help a typo).
- **Any other error:** an object that does not exist (42xxx) gets "it probably needs objects your
  platform creates: pass setup or preset"; anything else (42P17, a function in an index that is not
  IMMUTABLE) "PostgreSQL refused this statement: fix the SQL". "At that place" only when PostgreSQL
  gave a position.
- **25001** (a statement that cannot run beside others in one script, such as `CREATE INDEX
  CONCURRENTLY` or `VACUUM`): lint a copy of the folder in which it sits in a file of its own (alone in
  its file, it runs); the project's own migrations need not change.
- **55P04** (a new enum value used in the transaction that adds it): lint a copy in which the file is
  split in two; the project's own migrations, which may already have run, need not change.
- **Classes 53 and 54** (out of memory, a program limit): "the file needs more than the lint database
  can give it".

When `migrations` names one file, `files` cannot pick from it: a hint that would leave the file out
with `files` says to lint a copy without the part named instead (or, for 55P04, to split the file in
two and lint the folder that holds both), `FILE_TOO_LARGE` says to split it into a folder of smaller
files, and the hint that the files ran out of order is not given. A setup file over the size limit is
told to keep only what the migrations need.

**Example** (a migration that grants to a role only Supabase creates; PostgreSQL gives no position for
it): `MIGRATION_FAILED: "db/migrations/0004_rls.sql": "role \"authenticated\"
does not exist" (SQLSTATE 42704). Fix: This file needs objects your platform creates. For a Supabase
project call again with preset "supabase"; otherwise pass setup: a .sql file that creates them (CREATE
ROLE ..., CREATE SCHEMA ...).`

### 3.9 Limits
- At most 2,000 files, found among at most 10,000 files and folders, at most 100 folders deep. Each file costs a little more as
  the schema grows: on the author's laptop, 1,000 files of one table each took about 10 s, and 2,000
  took 26-38 s, close to the default time limit; for a folder that large, pass a larger
  `timeout_seconds` (the `TIMEOUT` advice says so) or lint one schema-only dump.
- Each file at most 5 MiB; all files together at most 20 MiB.
- A default, CHECK or index expression is read up to 2,000 characters for `fix_sql` (§3.6), each
  distinct text once, at most 50 of each kind for a column, and at most 1,000,000 characters in one
  lint, bounded in the database thread before the catalog reaches the server; a longer one, or one
  past those, counts as holding an amount, so the fix is withheld (this runs on the main thread, outside the time limit).
- Time limit from `timeout_seconds`.
- Memory: while the files run, the lint may take at most 1 GiB more than it had once the database
  had started. That is the database thread's own memory: its JavaScript heap and what it holds outside
  it (PGlite's WebAssembly memory and in-memory files), as Node.js 22.16 and later report for one
  thread, so what the main thread holds has no effect on it. What the database thread sends the main
  thread is bounded there before it is sent: each file's column keys and types must have their usual
  form, or the lint stops ("no longer answers correctly"); names over 512 characters make the catalog
  read fail; types are cut to 512 characters, and expressions as above. (Older Node.js cannot measure one thread:
  there the process's memory, less what the main thread's JavaScript heap and buffers hold, stands in,
  and memory the main thread frees but the system keeps can count against the lint: on Linux, 200 MiB
  of small objects freed during a lint counted up to 164 MiB. Node.js 22.16 or later avoids this.) It
  is checked ten times a second, so one statement can briefly take more before the check sees it. The
  checks and the time limit run on the server's main thread, which the ledger and audit tools never
  hold during a lint: they answer `BUSY` until it ends (§2.6). A file that needs more fails
  as `MIGRATION_FAILED` (`SETUP_FAILED` for setup) with a hint, and its database is discarded. (The
  worker's JavaScript heap has its own 1 GiB limit too.)
- One lint at a time, and one database thread at a time (§3.4).
- At most 50 findings in a result, fewer when they would pass 20,000 characters. The counts still cover
  them all, and `next_offset` gives the next page (the lint runs again for each).

### 3.10 Example
Project files:
```
db/migrations/0001_init.sql     create table orders (id bigserial primary key, total double precision not null, currency text not null default 'GBP');
db/migrations/0002_fees.sql     alter table orders add column platform_fee numeric(10,2) not null default 0;
db/migrations/0003_payouts.sql  create table payouts (id bigserial primary key, amount_pence bigint not null, fee_pence bigint not null);
```
This is the demo project in `fixtures/shop`. Call `{ "migrations": "db/migrations" }`. Result (the hash is
shortened):
```json
{
  "summary": "2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.",
  "migrations": "db/migrations",
  "migrations_sha256": "0f1de47f…",
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
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;" },
    { "code": "NUMERIC_MONEY", "severity": "warning", "table": "public.orders", "column": "platform_fee",
      "type": "numeric(10,2)", "introduced_in": "db/migrations/0002_fees.sql",
      "fix_sql": "ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING pg_catalog.round(platform_fee OPERATOR(pg_catalog.*) 100)::bigint;" }
  ],
  "findings_truncated": false,
  "next_offset": null,
  "other_float_columns": [],
  "other_float_columns_count": 0,
  "fixes": {
    "FLOAT_MONEY": "real and double precision are binary floating point: most decimal amounts (0.10, 19.99) cannot be stored exactly, and sums drift by fractions of a penny. Store integer minor units (pence, cents) in bigint: add a NEW migration with fix_sql and update the code that reads and writes the column. fix_sql takes the column to hold pounds or dollars and multiplies by 100, rounding to whole pence; when the name says the amounts are minor units already (pence, cents, minor units, or a currency without them such as jpy), it only rounds. Renaming the column to <column>_pence makes the unit clear. Before running a fix that multiplies by 100, check the triggers and functions that compare the column with an amount: the ALTER leaves them as they are.",
    "NUMERIC_MONEY": "numeric is exact, so this is not a rounding bug, but amounts with decimals are not integer minor units: every piece of code must round the same way. Convert to bigint minor units, or pass accept_numeric: true if numeric is a deliberate choice. fix_sql multiplies by 100 for 2 decimal places, keeps whole numbers (scale 0) as they are, and rounds to whole pence where no scale is declared; if a scale-0 column holds whole pounds rather than pence, multiply by 100 instead. Before running a fix that multiplies by 100, check the triggers and functions that compare the column with an amount: the ALTER leaves them as they are."
  }
}
```
`fixes` text for the other two codes:
- **`MONEY_TYPE`:** "Postgres's money type depends on the lc_monetary setting, has a fixed number of decimals and no currency, and rounds silently. Store integer minor units in bigint, with the currency in its own column. Constraints and defaults that use the money type must change in the same migration. Before running a fix that multiplies by 100, check the triggers and functions that compare the column with an amount: the ALTER leaves them as they are."
- **`SMALLINT_MONEY`:** "smallint holds at most 32,767 minor units (£327.67); a larger amount fails
  with an out-of-range error. Widen it to bigint; no data conversion is needed."

When a code has a finding whose `fix_sql` is null, its text ends with: "Where fix_sql is null, the
change needs a decision or belongs elsewhere: a domain or array type (change the domain or the element
type), a generated column (change its expression), a column a child table inherits (change it on the
parent), amounts finer than a penny, or the price of one unit in a float or a numeric with no scale, which may be (choose the unit first), a name that may not say its unit
(amount_minor, price_sat, cost_micros, amount_kwd: decide the unit first), a name that may not be money (total_passengers: if it is, list it in money_columns), a default, CHECK constraint or unique index
condition that may hold amounts in the old unit (convert
those in the same migration: ALTER COLUMN ... TYPE does not), a money value (0::money) in a default, CHECK constraint or index condition (it cannot work on a bigint), or a name holding hidden characters or a backslash before u (write it by hand)."

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
> amount, an amount with a debit/credit side column, or separate debit and credit columns; map currency
> too when the file has one (without it, every row counts as one currency). Amounts are
> integers in minor units by default (amount_format "decimal" reads 12.34 as 1234); no floating point is
> used. Findings give the exact line numbers (or JSON Pointers) and come in pages: for the next page,
> pass the next_offset the result gives as offset (a page can hold fewer than limit findings).
> Read-only.

### 4.2 Input
| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `file` (required) | string, a path | | `.csv`, `.tsv`, `.json`, `.jsonl` or `.ndjson`. |
| `columns` (required) | object (strict) | | Which column (CSV) or field (JSON) holds what (below). |
| `amount_format` | `"minor_units"` or `"decimal"` | `"minor_units"` | `minor_units`: integers (`1234` = £12.34). `decimal`: `12.34`. |
| `decimal_places` | integer 0-4 | 2 | Decimal places allowed in `decimal` format (0 for JPY, 3 for BHD). |
| `format` | `"csv"`, `"json"` or `"jsonl"` | from the extension (`.csv`/`.tsv` csv, `.json` json, `.jsonl`/`.ndjson` jsonl) | Overrides the extension, e.g. for a `.json` file that holds one object per line. |
| `delimiter` | `","`, `";"`, `"\t"` or `"\|"` | `","` (`"\t"` for `.tsv`) | CSV only. |
| `records_pointer` | string (a JSON Pointer, ≤ 256 characters, no control or invisible characters) | `""` (the root must be an array) | JSON only: where the array of records is, e.g. `"/data/entries"`. Every location in a JSON finding starts with it, so it is kept short and plain. |
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
  - RFC 4180 via `csv-parse`. The first row is the header. UTF-8; a BOM is ignored. Lines end with
    `\n`, `\r\n` or a lone `\r` (old Mac Excel); line numbers count all three.
  - Quoted fields may hold delimiters, `""` and line breaks.
  - Every row must have as many fields as the header (else `PARSE_ERROR` with the line). Blank lines
    are skipped.
  - Spaces around every value are ignored, and around a transaction id even inside quotes (`"T1 "` is
    `T1`; a quoted blank id is missing).
- **JSON:** the value at `records_pointer` must be an array. An element that is not an object is a
  `BAD_ROW` finding.
- **JSONL:** one JSON object per line. Blank lines are skipped. A line that is not a JSON object is a
  `BAD_ROW` finding, and the check goes on.
- **Excel's `sep=` line:** a CSV whose first line is `sep=;` (a line Excel reads; tools that write CSV for Excel add it), also in quotes or with spaces after it, is read
  with that delimiter, whatever `delimiter` says, and the line is not the header; lines still count from
  the file's first. It may end in LF, CR LF or a lone CR. When the header then reads as one column that
  holds another delimiter, COLUMN_NOT_FOUND's fix says the `sep=` line names the wrong one. A header
  whose first column starts `sep=` in another form (spaces around `=` too), and a PARSE_ERROR in a file whose first line does,
  get a fix that says to delete that line.
- **JSON parsing:** money-guard's own strict RFC 8259 parser (`src/ledger/json.ts`, adapted from
  sealed-audit-chain's; depth ≤ 100), **never `JSON.parse`**: V8 12.9 and later misparse escaped
  one-character keys, a bug the author found while building sealed-audit-chain. It keeps every
  **number as the exact text the file wrote**, never a 64-bit float, which would round
  4503599627370496.5 to a whole number and 1234567890123456789 to 1234567890123456800. A key that
  appears twice in one object keeps its last value, as `JSON.parse` and most readers do.
- **A mapped field that no record has** is `COLUMN_NOT_FOUND`, listing the first record's fields (as a
  missing CSV column lists the header). A field that only some records lack is `MISSING_VALUE` on
  those rows.
- **Transaction ids** are compared exactly. A JSON number id is its exact value as text: `1e3` is
  `1000`, and 1234567890123456789 stays itself. So the number `7` and the string `"7"` are one id,
  as they are in most exports that write ids either way. (The number `-0` is `0`, but the string `"-0"`
  stays itself: text is compared as written.)
- **Currency** is trimmed and upper-cased.
- **Locations:** CSV and JSONL findings give **line numbers**: 1-based, the header is line 1, and a
  multi-line CSV record is reported at the line where it starts. JSON findings give **JSON Pointers**
  (`/data/entries/7`).

### 4.4 Amounts (exact: no floating point anywhere)
- **`minor_units`:** an integer.
  - Accepted: a JSON number whose exact value is whole (`1000`, `1000.0`, `1e3`), or a string
    `-?[0-9]+`.
  - A fraction (`10.5`) is `FRACTIONAL_MINOR_UNITS`. So is text with a decimal point even when the
    fraction is zero (`12.00`): it usually means the column holds pounds, so use `decimal`. Its message
    says so (`"12.00" has a decimal point; minor units are whole numbers without one`). When at least as
    many amounts are plain decimals such as `12.34` as are whole numbers (zeros aside; a JSON `12.00`
    counts, though it is read as 12; `£12.00` and `1,234.50` do not, as `decimal` refuses them too),
    the summary adds: "Half or more of the non-zero amounts have a decimal point: if the file holds pounds or dollars (12.34),
    call again with amount_format "decimal"." With amount_format `decimal` it never does. A file of
    mostly whole pounds with a few decimals gets no hint: it looks the same as a pence file with a few
    wrong rows, and read as pounds that file would balance, hiding its errors.
  - Text that is not plain digits (`1e3`, `+5`, `(5)`, `1,000`) is `BAD_AMOUNT`, "is not written in plain
    digits, such as 1234"; a JSON object or array is "an object" or "an array".
- **`decimal`:** a string or number of the form `-?[0-9]+(\.[0-9]+)?`.
  - Digits past `decimal_places` must be zeros: with 2 places `12.340` is 1234, and `12.345` is
    `FRACTIONAL_MINOR_UNITS`.
  - Converted to integer minor units with exact string arithmetic: `12.3` with 2 places is `1230`.
  - A JSON number is read from its exact text, at any length and with any exponent: `1.234e1` is
    `1234`, and `12.340000000000000001` has more than 2 decimal places.
- **Refused as `BAD_AMOUNT` in text values:** thousands separators, currency symbols, `+`, brackets
  and exponents (the value is shown, ≤ 40 characters). Empty text and `null` are `MISSING_VALUE`.
- A JSON number is judged by its exact value: `1000`, `1000.0` and `1e3` are the same amount, and
  `4503599627370496.5` is not whole.
- **Range:** every amount must fit ±(2^53 − 1) minor units (`AMOUNT_TOO_LARGE`). More than 20 whole
  digits (after leading zeros), or a decimal point more than 400 places from the first significant
  digit (`1e400` and `1e-402`; `1e-401` is read as 401 decimal places), is refused at once, before any
  arithmetic. Digits the file writes out are read whatever their number: they cost no more than the
  file's own length. The exponent and the digits are
  weighed together: `1` followed by 2,000,000 zeros and `e-1999998` is 100. Reading a number takes
  time in proportion to its length. Sums use `BigInt`, so they are exact for any number of rows.

### 4.5 Findings
| Code | Severity | Level | Rule |
|---|---|---|---|
| `UNBALANCED` | error | transaction | In some currency the legs do not net to zero. `nets` lists each currency that is off. |
| `TOO_FEW_LEGS` | error | transaction | Fewer than two non-zero legs. |
| `ZERO_LEG` | warning | row | A leg of exactly 0. It moves nothing, and integer-pence-ledger refuses one. |
| `MISSING_VALUE` | error | row | A mapped value is missing or empty, or is something that cannot be an id or a currency: an object, an array, true or false (`field` says which). A side that is one of those is `BAD_SIDE`. |
| `BAD_AMOUNT` | error | row | Not a number in the chosen format (`value` shown). |
| `FRACTIONAL_MINOR_UNITS` | error | row | A fraction of a minor unit, or more decimal places than allowed. |
| `AMOUNT_TOO_LARGE` | error | row | Outside ±(2^53 − 1) minor units. |
| `BAD_SIDE` | error | row | A side value that is not D/DR/DEBIT/C/CR/CREDIT (an object, an array, true or false included). |
| `NEGATIVE_WITH_SIDE` | error | row | A negative amount where `side` already gives the direction. |
| `BAD_ROW` | error | row | A JSON or JSONL record that is not an object, or a JSONL line that is not JSON. |

A transaction with any row error is **not checked** for `UNBALANCED` or `TOO_FEW_LEGS`; its sum would
be noise. It is counted in `transactions_not_checked`. A transaction with fewer than two non-zero legs is
reported as `TOO_FEW_LEGS` only: its imbalance follows from that. A row without a transaction id is
reported on its own (`MISSING_VALUE`, `transaction_id: null`), as is a row whose id is a JSON number
too large or too small to use (more than 400 places, §4.4).

**Finding:**
| Field | Type | Meaning |
|---|---|---|
| `code`, `severity` | | As above. |
| `transaction_id` | string or null | Cut at 40 characters for display. Grouping always uses the full id. |
| `lines` | integer[] | CSV and JSONL: the rows involved, at most 20. |
| `pointers` | string[] | JSON: the records involved, at most 20, escaped as every copied text is (§2.4). |
| `more_rows` | integer | How many rows were left out of `lines`/`pointers`: past the first 20, or fewer when one finding alone would pass 20,000 characters (long pointers). |
| `field` | string | For row findings: `amount`, `side`, `debit`, `credit`, `currency`, `transaction_id`, or `debit/credit` when both are empty. |
| `value` | string | The offending text, ≤ 40 characters. |
| `nets` | `{ currency: string or null, net: string }[]` | For `UNBALANCED`: each currency that is off, in code-unit order of the currency, at most 20. `currency` is cut at 40 characters for display; grouping always uses the full text, and a JSON number currency (an ISO 4217 numeric code) its value: `826` and `826.0` are one currency. |
| `message` | string | ≤ 120 characters, e.g. `"GBP" legs net to -1, not 0`; a value or a currency from the file is shown in quotes, and a long list is cut at a whole part ("… and more…"). With more than 20 currencies off: "25 currencies do not net to 0; nets lists the first 20". |

The fields come in the order of this table. Findings are sorted by their first location, then by code.

### 4.6 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | e.g. "Not balanced: 2 errors. ..." (§4.9). It adds the pounds hint (§4.4) when it applies, and, when `currency` is not mapped but the file has a column or field whose name looks like a currency (the word currency, currencies, ccy, curr, commodity or commodities, or Währung, Devise, Moneda, Divisa, Valuta or 4217 (`iso_4217`, `ISO4217`), anywhere in it (but not curr before a date or a period word: `curr_month`), or cur alone or before code, unless it also holds an amount, balance, debit, credit, total, price, fee, value, period, rate, factor, ratio, pair or "in", or starts with is or has: `amount_currency` is an amount in another currency, `debit_in_account_currency` a debit; a plain name ("Currency", "ccy", "Currency Code") is named first, then one that ends in its currency word or in "code"; for a JSON Pointer, its last field: `Currency`, `Gross Currency`, `Currency (ISO)`, `iso_currency_code`, `baseCurrency`, `txn_ccy`; in JSON, a field of the first 1,000 records, or one beside a mapped JSON Pointer, such as `/amount/currency`; a currency field elsewhere in a record is not looked for): `"Currency" looks like a currency and is not mapped: map it as currency to check each currency on its own (now every row counts as one).` |
| `file`, `format`, `file_sha256` | string | `file_sha256` tells the model the file did not change between pages. |
| `rows_read` | integer | |
| `transactions_found`, `transactions_checked`, `transactions_balanced`, `transactions_not_checked` | integer | |
| `balanced` | boolean | True only when there is at least one row and no errors. An empty file proves nothing, so it is false. |
| `error_count`, `warning_count` | integer | Over all pages. |
| `counts_by_code` | object | e.g. `{ "UNBALANCED": 1 }`, over all pages. |
| `findings` | Finding[] | This page: at most `limit` findings, fewer if the result would pass its budget (§2.4). |
| `offset`, `limit`, `total_findings` | integer | `limit` as asked (default 20). |
| `next_offset` | integer or null | The first finding not on this page; null on the last page of the findings kept (the first 10,000, §4.8). When there are more, the summary says so: "Only the first 10,000 findings can be paged; the counts cover all N." On a page past the last finding, it says "No findings from offset 500: there are 30 to page." ("there is 1" for one). |

### 4.7 Errors (besides §2.5)
| Code | When |
|---|---|
| `PARSE_ERROR` | Broken CSV (an unclosed quote, the wrong number of fields, a row of more than 1 MiB of values or more than 10,000 fields) or invalid JSON (`json` format). Gives the line (CSV) or the line and column (JSON). When the CSV header holds none of the delimiter but another one, the fix names it: "The header looks separated by ";", not ",": pass delimiter ";"." |
| `COLUMN_NOT_FOUND` | A mapped CSV column is not in the header, or a mapped JSON field is in no record. Lists up to 30 header names or fields of the first record (each ≤ 40 characters) and the closest match (≤ 200 characters, so a long name can be mapped). When the header was read as one column that holds another delimiter (`;`, a tab, `\|` or `,`), the fix names that `delimiter` (the one that occurs most). |
| `COLUMN_AMBIGUOUS` | A mapped name appears twice in the header. |
| `MAPPING_INVALID` | The `columns` shape is not one of the three in §4.2. |
| `RECORDS_NOT_ARRAY` | The JSON value at `records_pointer` is not an array. Says what it is, e.g. "an object with keys data, meta" (≤ 20 keys, ≤ 40 characters each). When exactly one of its fields holds an array, the fix names that pointer ("/data"). |
| `TOO_MANY_ROWS` | More than 1,000,000 rows. |

### 4.8 Limits
- The file is at most 25 MiB and holds at most 1,000,000 rows.
- JSON nests at most 100 levels, and a file (all the lines of a JSONL file together) holds at most
  2,500,000 objects and arrays: each costs about 180 bytes of memory for one or two bytes of text, so
  a 25 MiB file of nested arrays would take over 2 GiB (`FILE_TOO_LARGE`). A million records with one
  nested object each fit. It holds at most 7,000,000 values of any kind (a number costs about 60 bytes
  for two of text; a file of records holds about 5 million at most), no object holds more than
  10,000 keys, and the file holds at most 100,000 different keys in all (each new key costs the
  parser time: 2.3 million spread over small records took up to 11 seconds) (`FILE_TOO_LARGE` too).
- A CSV row holds at most 1 MiB of values and at most 10,000 fields (`PARSE_ERROR`): a 25 MiB row of
  one-character fields took 15 seconds to read, and one of 26 million empty fields 11 seconds.
- At most 20 locations per finding.
- Pages of at most 50 findings. The first 10,000 findings, in order, can be paged; all of them are
  counted (`total_findings`, `counts_by_code`, the summary). A hostile file can make three findings a
  row, and keeping three million took 1.7 GB.
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
  "file_sha256": "9a9d3edc…",
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
      "nets": [{ "currency": "GBP", "net": "-1" }], "message": "\"GBP\" legs net to -1, not 0" },
    { "code": "FRACTIONAL_MINOR_UNITS", "severity": "error", "transaction_id": "T3", "lines": [6],
      "field": "amount", "value": "10.5", "message": "\"10.5\" is not a whole number of minor units" },
    { "code": "FRACTIONAL_MINOR_UNITS", "severity": "error", "transaction_id": "T3", "lines": [7],
      "field": "amount", "value": "-10.5", "message": "\"-10.5\" is not a whole number of minor units" },
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
- Its verdicts match its Python verifier's: sealed-audit-chain checks that with shared test vectors and
  a cross-language parity suite.

### 5.1 Description (exact, shown to the model)
> Prove an audit log was not edited, reordered or forged and, with an anchor, not cut short. Verifies
> a log written with sealed-audit-chain (one canonical JSON entry per line, each sealed with
> HMAC-SHA-256 and linked to the previous entry by SHA-256) byte for byte, and returns the first broken
> entry with its line and a reason code. The HMAC keys come from the server's configuration, never
> from arguments, and are never returned. Pass as anchor the head (count and last_hash) that an earlier
> successful run returned: the tool then also proves that the entries it vouched for then are all
> still there, unchanged; entries added since are fine. Without an anchor, entries removed from the end
> cannot be detected. Read-only: if a log fails, report it; never repair or re-seal it.

### 5.2 Input
| Parameter | Type | Meaning |
|---|---|---|
| `file` (required) | string, a path | `.jsonl`, `.ndjson` or `.log`. |
| `anchor` | object (strict): `count` integer 0 to 2^53 − 1, `last_hash` 64 lowercase hex | The `head` of an earlier run, or one the app stored. The first `count` entries must still be there, the last of them with hash `last_hash`; entries added after them are fine. Detects entries removed from the end, and a log replaced or rewritten. `count` 0 goes with the genesis hash (64 zeros). |

### 5.3 How it works
1. Check the path. Read the file once (≤ 100 MiB).
2. Build an `InMemoryKeyProvider` from `MONEY_GUARD_AUDIT_KEYS`. The keys never appear in a result, an
   error or a log line.
3. Call `verifyJsonl(bytes, keys)`, and map the library's reason to a stable code (§5.4). The anchor
   is not passed to the library: its anchor pins the **last** entry, which suits a head a writer stores
   at every append. An anchor here is a head from an earlier run, which an honest log grows past, so
   the tool checks it itself once the chain verifies: fewer entries than `count` is
   `ANCHOR_COUNT_MISMATCH`; entry `count − 1` with another hash is `ANCHOR_HEAD_MISMATCH`; more
   entries are fine, and the summary says how many were added. When the chain breaks after entry
   `count − 1`, the anchor is still checked against the entries that verified, first.
4. For `UNKNOWN_KEY_ID` and `HMAC_MISMATCH`, read that one entry's `writer_key_id` with `jsonlEntryAt`,
   so the message can say which key is missing (≤ 64 characters).
5. When the log verifies, return its `head` (`count` and `last_hash`) as the anchor to keep.

### 5.4 Reason codes
| Code | sealed-audit-chain reason | Plain meaning |
|---|---|---|
| `TORN_LAST_LINE` | last line is not terminated (torn) | A write was cut off, or the file was cut mid-line: a last line without LF that does not read as a JSON line (not JSON, not UTF-8, or too long). One that holds a whole entry is checked as it stands, so an edited or forged last entry is `CONTENT_TAMPERED`, `HMAC_MISMATCH` and so on, with the note "The last line also lacks its line end (LF); the entry on it is whole, so it was checked as it stands." When only the final LF is missing (§5.5 `notes`), the summary says the entry "lacks the line end a sealed log puts after every entry; with it, every entry verifies". |
| `LINE_TOO_LARGE` | line exceeds the canonical size limit | |
| `NOT_UTF8` | line is not valid UTF-8 | |
| `NOT_JSON` | line is not valid JSON | |
| `NOT_CANONICAL` | line is not in canonical form | The bytes were rewritten (spacing, key order, escapes). |
| `OUTSIDE_CANONICAL_DOMAIN` | line is outside the canonical domain | Floats, unsafe integers, lone surrogates or too deep. |
| `NOT_AN_OBJECT` | entry is not an object | |
| `SEQ_MISMATCH` | seq mismatch: expected N | Entries were inserted, removed or reordered. |
| `LINK_BROKEN` | prev_hash linkage broken (reorder/delete) | |
| `NOT_CANONICALIZABLE` | not canonicalizable: … | Not reached from a JSONL file today: a line the library reads is canonical JSON; the code is mapped so a later library version cannot pass one through unnamed. |
| `CONTENT_TAMPERED` | entry_hash mismatch (content tampered) | The entry was edited after sealing. |
| `UNKNOWN_KEY_ID` | unknown writer_key_id | No key is configured for this entry's key id. |
| `HMAC_MISMATCH` | HMAC mismatch (forged or unsealed) | Forged, or sealed with a different key. |
| `ENTRY_TOO_LARGE` | entry exceeds the canonical size limit | Not reached from a JSONL file today: the line-size check comes first (`LINE_TOO_LARGE`). Mapped for the same reason. |
| `ANCHOR_COUNT_MISMATCH` | money-guard's anchor check: "count N < anchor count M (truncation)" | Entries were removed from the end, or the log was replaced. |
| `ANCHOR_HEAD_MISMATCH` | money-guard's anchor check: "entry N hash does not match anchor" | The log was replaced or rewritten. |
| `OTHER` | anything else | Only if a newer library adds a reason. The raw reason is included. |

A test produces every reason the library can return through `verifyJsonl` and fails if one is not
mapped.

### 5.5 Output (`structuredContent`)
| Field | Type | Meaning |
|---|---|---|
| `summary` | string | |
| `file`, `file_sha256` | string | |
| `ok` | boolean | |
| `entries_verified` | integer | The entries vouched for: all of them when `ok` (the library's `lastSeq + 1`); otherwise those before the break (`break.entry_index`). For `ANCHOR_HEAD_MISMATCH` that is the entries before the one the anchor recorded (its count less one): their chain verified, though the log may have been replaced. |
| `break` | object or null | `{ entry_index, line, code, reason, writer_key_id? }`. `line` = `entry_index + 1`, or null when that line does not exist (an anchor that counts more entries). `reason` is sealed-audit-chain's wording, cut at 120 characters (a canonicalization error can quote a key name from the line). |
| `anchor_checked` | boolean | True when an anchor was given and compared, also when the chain breaks after the entries it covers (a log that was replaced is then reported first, as `ANCHOR_HEAD_MISMATCH`, so a later break that looks like an accident cannot hide it); false when the chain breaks at or before the last entry it covers, so the entries it vouched for could not be checked (a note says so). When only the final LF is missing, the anchor is compared with the log with that LF restored: true when it matches, with the note "The anchor matches the log once the line end after its last entry is restored." if it covers the last entry. |
| `head` | object or null | `{ count, last_hash }` when `ok`. Keep it and pass it as `anchor` next time. |
| `key_ids_configured` | string[] | Ids only, never key bytes. |
| `notes` | string[] | e.g. "No anchor was given, so entries removed from the end cannot be detected." For an empty log without an anchor: "The log is empty. An empty log always verifies; pass an anchor to detect a deleted or emptied log." When the file has CR LF line ends (a sealed log has LF only), a note names the first such line, the likely cause (git's core.autocrlf on Windows) and the fix; one that starts with a byte order mark gets a note that an editor may have added it. When only the final LF is missing (with it, every entry verifies, and an anchor, if given, matches the log with it: otherwise the answer the log gets with that LF, `ANCHOR_COUNT_MISMATCH` or `ANCHOR_HEAD_MISMATCH`, with the note that the last line lacks its LF): "Only the line end after the last entry is missing: with it, every entry verifies. A sealed log ends each line with LF; an editor or a copy may have dropped the last one." Otherwise, when the log ends inside an entry the anchor covers: "The anchor covers 5 entries, but the log ends inside entry 3: it was cut short, and entries the anchor vouched for are gone." When the break is `UNKNOWN_KEY_ID`, or `HMAC_MISMATCH` at the first entry or the first after a change of key id: "A wrong key setting gives this answer too, for an untouched log: check that MONEY_GUARD_AUDIT_KEYS holds the key that sealed the log before calling it tampered." |

### 5.6 Errors (besides §2.5)
| Code | When |
|---|---|
| `KEYS_NOT_CONFIGURED` | `MONEY_GUARD_AUDIT_KEYS` is unset or empty. The fix text says how to set it in the server's env (`.mcp.json` with `${...}`), never in chat. |
| `KEYS_INVALID` | The setting is malformed, or has more than 64 pairs. Names the pair by its position only, never any of its text. A value that starts or ends with a quote mark is told to drop the quotes kept around it. |

A bad `anchor` (wrong hex, a negative count) is refused by the input schema.

### 5.7 Limits
The file is at most 100 MiB. Verification is linear, verifies the log once and stops at the first break. A
log whose last line has no LF is read once with an LF added (a copy of the file): the entries before
that line are the same either way, so a break there is the log's break, and at that line the log is torn.

### 5.8 Example
The demo project's log, `fixtures/shop/logs/audit.jsonl`: two entries sealed with the test key `k1`. Call
`{ "file": "logs/audit.jsonl" }` (hashes shortened):
```json
{
  "summary": "The log verifies: 2 entries, every seal and link intact. Keep head and pass it as anchor next time.",
  "file": "logs/audit.jsonl",
  "file_sha256": "1d964af7…",
  "ok": true,
  "entries_verified": 2,
  "break": null,
  "anchor_checked": false,
  "head": { "count": 2, "last_hash": "36cc1b2f…" },
  "key_ids_configured": ["k1"],
  "notes": ["No anchor was given, so entries removed from the end cannot be detected."]
}
```
After someone changes `alice` to `mallory` in the first entry (`logs/audit-tampered.jsonl`):
```json
{
  "summary": "The log does NOT verify: entry 0 (line 1) was edited after it was sealed (CONTENT_TAMPERED).",
  "file": "logs/audit-tampered.jsonl",
  "file_sha256": "abfac011…",
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
  system catalogs. money-guard catches mistakes; it is not a defence against hostile migrations. Such
  a migration still cannot slip SQL into the `fix_sql` the model is told to run: money-guard writes it
  itself and quotes every name (§3.6). What the catalog reports (a type, a default) still decides which
  fix is offered.

---

## 7. How it is proven (the test suite)
The tests are in `test/` (Vitest, about 1,000); each file starts with a comment saying what it proves.
- **Projects are built inside the tests.** Each test writes a small project (migrations, an export or a
  log) into a temporary folder, so every case sits next to its expected answer. `fixtures/shop` is the
  one shared demo project: the README example, the stdio, Inspector and bundle tests use it. Its audit
  logs are generated by `scripts/fixtures.mts`, and a test fails if the committed files differ.
- **Lint cases:** the §3.10 example; every kind of column (domains, arrays, the money type, smallint,
  generated columns, quoting, partitions, inheritance, views); renames and type changes; natural order,
  Prisma folders, Flyway `files`, and the up and down markers of dbmate, goose, sql-migrate,
  node-pg-migrate and tern (down before up, and comments that only look like a marker); a pg_dump 18
  file with `\restrict`; failures with the line and column where PostgreSQL gives a position, and each hint
  as real PostgreSQL triggers it; the Supabase preset; a setup file inside the migrations folder, a
  folder that holds only the setup file, and a setup file that fails in each way (`SETUP_FAILED`,
  with advice for the setup file); advice without `files` when `migrations` is one file; pgvector;
  every kind of `fix_sql` run on stored rows, with names quoted as `quote_ident` quotes them, and
  none offered while a default, a CHECK constraint, or a unique or exclusion index's condition or
  expression would keep amounts in pounds (in the table, or in a partition or child at any depth),
  while an ordinary index's condition does not count; none for a name with a backslash before "u",
  or with "minor" or "sat" that may not name the unit (`price_sat`); the check after each file reads
  only the columns that file created or changed; a file that leaves a transaction open fails; each
  file may lock thousands of objects; an object created twice gets its own hint; and the setup file
  named as the migrations or in `files` says so, as when it is found in the folder.
- **Ledger cases:** the §4.9 example; every finding code; the three column shapes; decimal mode and
  when the summary suggests it; header names matched exactly before letter case; CSV line numbers
  (quoted line breaks, CR LF, a lone CR, a BOM, blank lines); JSON Pointers; JSONL with a bad line;
  exact JSON numbers (ids a float would merge, fractions it would round away), shown as written, and
  every hex digit of a `\u` escape in both cases; the unmapped-currency hint in CSV, JSON and JSONL,
  for currency words anywhere in a name and fields the first record lacks; a numeric currency grouped
  by its value; the delimiter that occurs most; pagination and the result budget; hostile files kept
  small and fast (the first 10,000 findings kept, all counted; a CSV row of more than 1 MiB of values
  or more than 10,000 fields; a million JSONL lines that are not JSON;
  more than 7,000,000 JSON values; an object of more than 10,000 keys; the summary says when paging
  stops at 10,000); an amount in a currency (`amount_currency`) not taken for the currency column; zeros
  left aside by the pounds hint.
- **Audit cases:** a valid log; one log per reason a log can trigger (tampered, reordered, an entry
  deleted, a cut tail, a torn line, a wrong key, a forged seal, a rewritten line, CR LF line ends);
  anchors from an earlier run (grown, emptied, replaced, broken at the last entry the anchor covers,
  and broken at the entry right after it, honestly or after a replacement); and a scan of the library's code that fails if it can
  return a reason this server does not map.
- **Every error code** and every finding code is produced by a test. **Names:** about 500 column names,
  real ones and edge cases written for each rule, with the expected answer.
- **Security:** `..`, absolute paths and links leading out of the project (and, through such a link,
  the same answer whether the path behind it exists or not) (the file-link cases skip
  on Windows without Developer Mode, and the test run says so); secret files, also behind a link in a
  migrations folder; a hostile project whose file, table and column names hold hidden characters,
  zero-width and TAG characters among them (no raw hidden character reaches any result or error,
  checked by the tests' own Unicode-category test, not by the code under test); a migration that
  redefines `quote_ident` (`fix_sql` does not change); a migration that tries to read a real file on
  the machine three ways, or to run a program; key material never echoed, from results or from
  malformed settings, nor accepted as a key id (32 hex digits or more); every place that shows a path,
  cut and escaped without the server's final pass; the JSON Pointer pattern on hostile input; an
  oversized stdio message.
- **Limits and time:** the 20,000-character budget with the longest names in a deep folder, with one
  migration 18 to 30 folders deep (its path cut in the middle) and with long records pointers (and
  every ledger result in the tests is held to it); a JSON number with long runs of zeros, read in
  linear time; the final catalog read of a 400-table schema, in well under the time limit (it grows
  with the schema, not with its square); the size and row limits; a migration whose data outgrows the
  memory limit, and memory
  the server's own thread takes during a lint (not counted against it); a file or folder nobody may
  read or open (POSIX), as a path argument, in a migrations folder, in `files` or behind a link there,
  which is `FILE_UNREADABLE`, not a crash (and a project folder nobody may open, which `ROOT_INVALID`
  says); an endless migration stopped at the time limit; a stand-in database thread that goes silent
  (caught within 5 seconds), answers late while the server's thread is busy (not called silent),
  answers wrongly, dies while a file runs (that file is named), runs forever (its heartbeat stops at
  the time limit and on a cancel), cannot start (`INTERNAL_ERROR` without detail, its cause in the
  log), or runs out of time, dies or outgrows its memory while it reads the catalog (said as such);
  a migration that breaks that read by replacing `pg_catalog.format_type`; a setup file whose
  database thread dies (`SETUP_FAILED`); one database thread at a time (the next waits for the last
  to end, even when ending is slow), and the messages the real thread sends; the limits a lint gets
  when the caller sets none (a 1 GiB JavaScript heap, 1 GiB of growth, a stuck database called stuck
  after 5 seconds and not sooner); memory that the server's own thread holds during a lint, its
  JavaScript heap and buffers, on both ways of measuring it (the older one in a process of its own); and EPERM and EBUSY, which the test
  machines cannot raise on demand, through a wrapped file system; a lint that waits for the last database thread
  keeps its time limit and its cancel.
- **Protocol:** in-process tests in both eras; a separate process over stdio in both eras, with
  `CLAUDE_PROJECT_DIR`; a client's cancel stopping a running lint; a cancel that arrives before the
  call ran (logged `CANCELLED`, no answer, and the call not run at all), and one that arrives while a
  ledger call runs (answered, logged `ok`); the client going away mid-lint (`DISCONNECTED`, then the process exits); an error
  no handler caught and a rejection no one handled (their types logged, the server keeps serving);
  the host closing the server's stderr, or never reading it (it keeps answering; the log queue drops
  lines past 100; on Linux the piped stderr is non-blocking); stdout purity (a stand-in database thread that writes to stdout and
  stderr through Node's streams and console, as PGlite prints, is contained; a thread could still
  write to file descriptor 1 directly, which PGlite never does); advertised schemas that fit the Claude
  API (no root combinators, short plain names, no type arrays); `listChanged: false`; `null` for
  every optional argument; unknown and misspelt parameters refused; `INTERNAL_ERROR` without detail.
- **Documents that cannot drift:** the README shows `examples/demo.mjs`, its exact output and the real
  lint result; the server instructions, tool descriptions and `fixes` texts here are compared with the
  code; the bundle manifest is compared with `package.json`; no text file holds a raw hidden character
  (checked over the files git tracks, or the whole folder where git tracks none).
- **Set up in CI, outside the suite** (run by hand so far, until CI runs): the official MCP Inspector
  in both eras (`--strict` reports nothing); the packed tarball installed into an empty project; the
  Claude Desktop bundle built and started from its manifest; Node.js 22.12, the oldest the package
  supports. The whole suite has passed on Windows (Node 24) and on Linux (Node 22, in WSL), where the
  file-link and permission tests that Windows skips run too.
- **Way of working:** each test added in a review round is shown to fail on the code before its fix;
  review rounds go on until one finds no HIGH; a fresh-clone rehearsal comes before publishing. A
  slow machine fails only the slow test: lint tests run one lint each where they can, and a lint that
  a test left running when it ran out of time is cancelled as the test ends, so the tests after it
  do not get `BUSY`.

---

## 8. Design decisions (2026-10-14)
1. **Supabase preset in v1? → YES.** Many AI-built apps use Supabase, and without the
   preset their migrations fail on `auth.users` or `TO authenticated`.
2. **How strict about `numeric` money columns? → A WARNING**, which `accept_numeric: true` turns
   off. `numeric` is exact, so it is not a rounding bug, but money-guard's own approach is integer
   minor units. The other choices are an error, or no report at all.
