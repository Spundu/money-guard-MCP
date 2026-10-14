// What money_lint_schema reads from the PostgreSQL catalog (SPEC.md §3.4) and how it judges each column
// (§3.5, §3.6). The SQL runs in the worker; the judging is pure and runs here.
//
// Every catalog object is named with its schema (pg_catalog.), so a migration that changes search_path
// (pg_dump output does) cannot change what these queries read.

import { hasUnsafe } from '../echo.js';
import { looksLikeMoney, namesMinorUnits } from './names.js';

/** Ordinary and partitioned tables in non-system schemas: the relations whose columns are checked. */
const USER_TABLES = `
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;

/**
 * Taken after every file: each column's identity (table oid + column number, which survive renames)
 * and its exact type (type oid + modifier). Cheap enough to run thousands of times.
 */
export const SNAPSHOT_SQL = `
  SELECT a.attrelid::pg_catalog.text || ':' || a.attnum::pg_catalog.text AS col,
         a.atttypid::pg_catalog.text || ':' || a.atttypmod::pg_catalog.text AS ty
  ${USER_TABLES}`;

/**
 * Taken once, at the end: everything the findings need. Domains are followed to their base type at any
 * depth, and arrays to their element type. Partitions are left out (their parent is reported),
 * inherited columns too (reported where defined), and tables that belong to an extension.
 */
export const DETAIL_SQL = `
  WITH RECURSIVE cols AS (
    SELECT a.attrelid::pg_catalog.text || ':' || a.attnum::pg_catalog.text AS col,
           n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS declared, a.atttypid AS typid,
           a.attgenerated::pg_catalog.text AS generated,
           pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS quoted_table,
           pg_catalog.quote_ident(a.attname) AS quoted_column
    ${USER_TABLES}
      AND NOT c.relispartition AND a.attislocal
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'e')
  ),
  chain AS (
    SELECT t.oid AS start, t.oid AS cur, false AS via_array, NULL::pg_catalog.text AS domain_name, 0 AS depth
    FROM pg_catalog.pg_type t WHERE t.oid IN (SELECT typid FROM cols)
    UNION ALL
    SELECT ch.start,
           CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.typelem END,
           ch.via_array OR t.typtype <> 'd',
           COALESCE(ch.domain_name, CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.oid, NULL) END),
           ch.depth + 1
    FROM chain ch JOIN pg_catalog.pg_type t ON t.oid = ch.cur
    WHERE (t.typtype = 'd' OR (t.typcategory = 'A' AND t.typelem <> 0)) AND ch.depth < 32
  ),
  base AS (
    SELECT DISTINCT ON (ch.start) ch.start, ch.via_array, ch.domain_name,
           t.typname::pg_catalog.text AS base_name, tn.nspname::pg_catalog.text AS base_schema
    FROM chain ch
    JOIN pg_catalog.pg_type t ON t.oid = ch.cur
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    ORDER BY ch.start, ch.depth DESC
  )
  SELECT cols.col, cols.schema_name, cols.table_name, cols.column_name, cols.declared, cols.generated,
         cols.quoted_table, cols.quoted_column, base.via_array, base.domain_name, base.base_name, base.base_schema
  FROM cols JOIN base ON base.start = cols.typid
  ORDER BY cols.schema_name, cols.table_name, cols.column_name`;

export interface DetailRow {
  col: string;
  schema_name: string;
  table_name: string;
  column_name: string;
  declared: string;
  /** '' for an ordinary column, 's' or 'v' for a generated one. */
  generated: string;
  quoted_table: string;
  quoted_column: string;
  via_array: boolean;
  domain_name: string | null;
  base_name: string;
  base_schema: string;
}

export type LintCode = 'FLOAT_MONEY' | 'MONEY_TYPE' | 'NUMERIC_MONEY' | 'SMALLINT_MONEY';

export interface LintFinding {
  code: LintCode;
  severity: 'error' | 'warning';
  table: string;
  column: string;
  type: string;
  introduced_in: string;
  fix_sql: string | null;
}

/** One plain explanation per code (SPEC.md §3.10), returned once for each code present. */
export const FIXES: Readonly<Record<LintCode, string>> = {
  FLOAT_MONEY:
    'real and double precision are binary floating point: most decimal amounts (0.10, 19.99) cannot be stored exactly, and sums drift by fractions of a penny. Store integer minor units (pence, cents) in bigint: add a NEW migration with fix_sql (it multiplies by 100, assuming the column holds pounds or dollars with 2 decimals) and update the code that reads and writes the column. Renaming it to <column>_pence makes the unit clear.',
  MONEY_TYPE:
    "Postgres's money type depends on the lc_monetary setting, has a fixed number of decimals and no currency, and rounds silently. Store integer minor units in bigint, with the currency in its own column.",
  NUMERIC_MONEY:
    'numeric is exact, so this is not a rounding bug, but the amounts are not integer minor units: every piece of code must round the same way. Convert to bigint minor units, or pass accept_numeric: true if numeric is a deliberate choice.',
  SMALLINT_MONEY: 'smallint holds at most 32,767 minor units (£327.67); a larger amount fails with an out-of-range error. Widen it to bigint; no data conversion is needed.',
};

const SQL_NAMES: Readonly<Record<string, string>> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  numeric: 'numeric',
  money: 'money',
};

/** The base type, if it is one of PostgreSQL's own number types; null for anything else. */
export function baseType(row: DetailRow): string | null {
  return row.base_schema === 'pg_catalog' ? (SQL_NAMES[row.base_name] ?? null) : null;
}

/** "double precision", or for a domain "pence (bigint)". */
export function displayType(row: DetailRow): string {
  if (row.domain_name === null) return row.declared;
  const base = SQL_NAMES[row.base_name] ?? row.base_name;
  return `${row.domain_name} (${base}${row.via_array ? '[]' : ''})`;
}

/** The finding code for a column, given whether it counts as money; null when it is fine. */
export function judge(row: DetailRow, isMoney: boolean, acceptNumeric: boolean): LintCode | null {
  const base = baseType(row);
  if (base === 'money') return 'MONEY_TYPE';
  if (!isMoney) return null;
  if (base === 'real' || base === 'double precision') return 'FLOAT_MONEY';
  if (base === 'numeric') return acceptNumeric ? null : 'NUMERIC_MONEY';
  if (base === 'smallint') return 'SMALLINT_MONEY';
  return null;
}

/**
 * A starting point for the fix, or null where the change belongs elsewhere: a domain (change the
 * domain), an array, or a generated column (change its expression). Also null when a name holds a
 * control or invisible character: results show such names escaped, and SQL built from the escaped
 * text would name a different column.
 */
export function fixSql(row: DetailRow, code: LintCode): string | null {
  if (row.domain_name !== null || row.via_array || row.generated !== '') return null;
  if (hasUnsafe(row.quoted_table) || hasUnsafe(row.quoted_column)) return null;
  const head = `ALTER TABLE ${row.quoted_table} ALTER COLUMN ${row.quoted_column} TYPE bigint`;
  const c = row.quoted_column;
  switch (code) {
    case 'SMALLINT_MONEY':
      return `${head};`;
    case 'MONEY_TYPE':
      return `${head} USING (${c}::numeric * 100)::bigint;`;
    case 'FLOAT_MONEY':
    case 'NUMERIC_MONEY':
      return namesMinorUnits(row.column_name) ? `${head} USING round(${c})::bigint;` : `${head} USING round(${c} * 100)::bigint;`;
  }
}

/** Whether `looksLikeMoney` or the caller's lists make a column money. */
export function isMoneyColumn(row: DetailRow, listed: ReadonlySet<string>): boolean {
  return looksLikeMoney(row.column_name) || listed.has(`${row.schema_name}.${row.table_name}.${row.column_name}`);
}
