// The tools' input and output schemas (SPEC.md §3.2, §3.7, §4.2, §4.6, §5.2, §5.5). The SDK derives the
// JSON Schema the model sees from them, validates every call's arguments before a handler runs, and
// validates every structured result before it leaves the server.
//
// Rules the clients impose (SPEC.md §1, fact 3): no anyOf/oneOf/allOf at the root of an input schema
// (the Claude API refuses it), and property names of 1-64 characters from [A-Za-z0-9_.-]. Every object
// is strict, so a misspelt parameter is reported instead of ignored. Optional parameters also accept
// null, which models sometimes send for "not given". A nullable value must render as anyOf branches,
// never as a type array (['string', 'null']), which some clients cannot read: zod writes anyOf only when
// the non-null branch has a keyword of its own (a title, a minLength), so each one has.

import * as z from 'zod/v4';
import { hasUnsafe } from './echo.js';

const path = (what: string) => z.string().min(1).max(1024).describe(what);
const name = z.string().min(1).max(200);
// A JSON Pointer (RFC 6901). A token may not hold "/": if "[^~]" could also match the separators, a
// failing match (40 slashes and a "~") would backtrack for hours inside argument validation.
export const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
const columnName = name.refine((v) => !v.startsWith('/') || POINTER.test(v), 'a name starting with "/" must be a valid JSON Pointer');

// ------------------------------------------------------------------------------------------- inputs

export const lintInput = z
  .object({
    migrations: path('A folder of .sql migration files, or one .sql file (a pg_dump --schema-only file, say), relative to the project root.'),
    files: z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(2000)
      .nullish()
      .describe('Run exactly these files, in this order, as paths relative to migrations. Default: every .sql file under the folder in natural order (V2 before V10), down steps skipped.'),
    preset: z.enum(['supabase']).nullish().describe('Built-in setup for a Supabase project: its roles, auth.users, auth.uid(), storage and extensions schema.'),
    setup: z.string().min(1).max(1024).nullish().describe('A .sql file, relative to the project root, run before the migrations (after preset) to create what your platform provides: roles, schemas, functions. Its columns are not checked; if it lies in the migrations folder it is not run again as a migration.'),
    accept_numeric: z.boolean().meta({ title: 'Accept numeric' }).nullish().describe('Treat numeric/decimal money columns as fine instead of warning about them. Default false.'),
    money_columns: z.array(z.string().min(3).max(200)).max(200).nullish().describe('Extra columns to treat as money: "table.column" (schema public) or "schema.table.column".'),
    ignore_columns: z.array(z.string().min(3).max(200)).max(200).nullish().describe('Columns never to report (false positives), as "table.column" or "schema.table.column". They are counted in ignored_count.'),
    timeout_seconds: z.number().int().min(5).max(300).nullish().describe('Stop after this many seconds. Default 45: most clients wait at most 60 for an answer.'),
  })
  .strict();

export const ledgerInput = z
  .object({
    file: path('The export: a .csv, .tsv, .json, .jsonl or .ndjson file, relative to the project root.'),
    columns: z
      .object({
        transaction_id: columnName.describe('The column (CSV) or field (JSON) that groups rows into transactions.'),
        amount: columnName.nullish().describe('A signed amount; or a non-negative amount when side is mapped.'),
        side: columnName.nullish().describe('A debit/credit column: D, DR or DEBIT, and C, CR or CREDIT.'),
        debit: columnName.nullish().describe('A debit column; give credit too. An empty cell counts as 0.'),
        credit: columnName.nullish().describe('A credit column; give debit too. An empty cell counts as 0.'),
        currency: columnName.nullish().describe('A currency column. Without it every row is one currency.'),
      })
      .strict()
      .describe('Which column (CSV) or field (JSON) holds what: transaction_id plus one of: amount; amount and side; or debit and credit. In JSON, a name starting with "/" is a JSON Pointer into each record.'),
    amount_format: z.enum(['minor_units', 'decimal']).nullish().describe('minor_units (default): whole numbers such as 1234 for £12.34. decimal: 12.34.'),
    decimal_places: z.number().int().min(0).max(4).nullish().describe('Decimal places allowed with amount_format decimal: 2 (default), 0 for JPY, 3 for BHD.'),
    format: z.enum(['csv', 'json', 'jsonl']).nullish().describe('Overrides the format the extension gives.'),
    delimiter: z.enum([',', ';', '\t', '|']).nullish().describe('CSV delimiter. Default "," (tab for .tsv).'),
    records_pointer: z
      .string()
      .max(256)
      .regex(POINTER)
      // Every location in a JSON finding repeats it, so it must read as it is and stay short.
      .refine((v) => !hasUnsafe(v), 'records_pointer cannot hold control or invisible characters')
      .nullish()
      .describe('JSON only: the JSON Pointer of the array of records, such as "/data/entries". Default: the top of the file.'),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish().describe('The first finding to return. Default 0.'),
    limit: z.number().int().min(1).max(50).nullish().describe('How many findings to return. Default 20, at most 50.'),
  })
  .strict();

export const auditInput = z
  .object({
    file: path('The audit log: a .jsonl, .ndjson or .log file, relative to the project root.'),
    anchor: z
      .object({
        count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('How many entries the log had.'),
        last_hash: z.string().regex(/^[0-9a-f]{64}$/).describe('The entry_hash of its last entry: 64 lowercase hex digits.'),
      })
      .strict()
      .nullish()
      .describe('The head an earlier successful run returned (or one your app stores). Detects entries removed from the end.'),
  })
  .strict();

// ------------------------------------------------------------------------------------------ outputs

const lintFinding = z.object({
  code: z.enum(['FLOAT_MONEY', 'MONEY_TYPE', 'NUMERIC_MONEY', 'SMALLINT_MONEY']),
  severity: z.enum(['error', 'warning']),
  table: z.string(),
  column: z.string(),
  type: z.string(),
  introduced_in: z.string(),
  fix_sql: z.string().min(1).nullable(),
});

export const lintOutput = z.object({
  summary: z.string(),
  migrations: z.string(),
  migrations_sha256: z.string(),
  postgres: z.string(),
  files_applied_count: z.number().int(),
  files_applied: z.array(z.string()),
  files_applied_truncated: z.boolean(),
  tables_checked: z.number().int(),
  money_columns_checked: z.number().int(),
  error_count: z.number().int(),
  warning_count: z.number().int(),
  ignored_count: z.number().int(),
  findings: z.array(lintFinding),
  findings_truncated: z.boolean(),
  other_float_columns: z.array(z.string()),
  other_float_columns_count: z.number().int(),
  fixes: z.record(z.string(), z.string()),
});

const ledgerFinding = z.object({
  code: z.enum(['UNBALANCED', 'TOO_FEW_LEGS', 'ZERO_LEG', 'MISSING_VALUE', 'BAD_AMOUNT', 'FRACTIONAL_MINOR_UNITS', 'AMOUNT_TOO_LARGE', 'BAD_SIDE', 'NEGATIVE_WITH_SIDE', 'BAD_ROW']),
  severity: z.enum(['error', 'warning']),
  transaction_id: z.string().min(1).nullable(),
  lines: z.array(z.number().int()).optional(),
  pointers: z.array(z.string()).optional(),
  more_rows: z.number().int().optional(),
  field: z.string().optional(),
  value: z.string().optional(),
  nets: z.array(z.object({ currency: z.string().min(1).nullable(), net: z.string() })).optional(),
  message: z.string(),
});

export const ledgerOutput = z.object({
  summary: z.string(),
  file: z.string(),
  format: z.enum(['csv', 'json', 'jsonl']),
  file_sha256: z.string(),
  rows_read: z.number().int(),
  transactions_found: z.number().int(),
  transactions_checked: z.number().int(),
  transactions_balanced: z.number().int(),
  transactions_not_checked: z.number().int(),
  balanced: z.boolean(),
  error_count: z.number().int(),
  warning_count: z.number().int(),
  counts_by_code: z.record(z.string(), z.number().int()),
  findings: z.array(ledgerFinding),
  offset: z.number().int(),
  limit: z.number().int(),
  total_findings: z.number().int(),
  next_offset: z.number().int().nullable(),
});

const anchorShape = z.object({ count: z.number().int(), last_hash: z.string() });

export const auditOutput = z.object({
  summary: z.string(),
  file: z.string(),
  file_sha256: z.string(),
  ok: z.boolean(),
  entries_verified: z.number().int(),
  break: z
    .object({
      entry_index: z.number().int(),
      line: z.number().int().nullable(),
      code: z.string(),
      reason: z.string(),
      writer_key_id: z.string().optional(),
    })
    .nullable(),
  anchor_checked: z.boolean(),
  head: anchorShape.nullable(),
  key_ids_configured: z.array(z.string()),
  notes: z.array(z.string()),
});
