# money-guard-mcp

An MCP server (stdio, SDK v2, protocol 2026-07-28 plus the 2025 era) with three read-only tools:
`money_lint_schema` (runs SQL migrations in PGlite, flags unsafe money column types),
`money_check_double_entry` (checks a ledger export balances, with exact integer maths) and
`audit_verify_chain` (verifies a sealed-audit-chain log).

**SPEC.md is the contract.** It fixes every parameter, output field, finding code, error code and limit,
and §7 lists the tests that prove them. To change behaviour, change SPEC.md first, then the code and its
tests in the same commit. Codes and field names are public API (SPEC.md §2.9).

Rules:
- Read-only and offline: no writes, no network, no shell, no child processes. stdout carries only the
  protocol; diagnostics go to stderr, never file content, keys or absolute paths.
- Never parse SQL text: execute it (PGlite, in `src/lint/worker.js`) and read the catalog. The only text
  recognised is file-format markers, matched by line: the up and down markers of dbmate, goose,
  sql-migrate, node-pg-migrate and tern, and pg_dump's `\restrict` (the error hints also look for
  `COPY ... FROM stdin;` and for a failing line that starts with `\`, a psql meta-command).
- Never `JSON.parse` untrusted JSON: use `parseLedgerJson` (src/ledger/json.ts; V8 12.9+ misparses
  escaped one-character keys). It keeps numbers as their exact text: never turn one into a float.
- Money is integers: `BigInt` for sums; amounts in results are strings of minor units; no floats.
- Every path argument goes through `resolveInRoot` (src/paths.ts). Every tool failure is a `ToolError`
  with a code from SPEC.md.
- Results are deterministic and at most 20,000 characters (src/budget.ts). A value echoed from a data
  file goes through `clip`; a database name goes through `escapeUnsafe`; a path goes through `clipPath`
  (cut in the middle past 400 characters), in results and in error messages alike (src/echo.ts). Apply
  each once, to raw text: a second pass would double the backslash of its own escapes (a raw value
  that goes into a longer text is `cut`, and the whole text clipped once). The server escapes hidden
  characters in every outgoing string once more (`escapeHidden`), but the tools must not rely on it.
- SQL that money-guard writes (`fix_sql`) is built in TypeScript from catalog names, never by SQL
  functions in the lint database: the migrations control that database.
- In tests, write a hidden character as `\u{200b}` (braces): tool inputs turn the four-digit form into
  the raw character, which `test/hygiene.test.ts` then refuses. Check results with `RAW_HIDDEN`
  (test/support/hidden.ts), not with the code under test.
- HMAC keys come only from `MONEY_GUARD_AUDIT_KEYS`; they never appear in a result, an error or a log.
- Every new test must fail without the code it covers (stash the source, run, pop).
- The README shows real things: its example is `examples/demo.mjs`, and `test/readme.test.ts` checks
  that the README shows that file, its output and the demo lint result exactly. Change them together.
- Verify before done: `npm run typecheck && npm run lint && npm test && npm run build`.
