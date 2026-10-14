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
 * and its type (the type oid, without the modifier: widening numeric(10,2) to numeric(12,2) does not
 * introduce a problem the column already had; real and double precision count as one float type, so a
 * change of float precision does not either). Cheap enough to run thousands of times.
 */
export const SNAPSHOT_SQL = `
  SELECT a.attrelid::pg_catalog.text || ':' || a.attnum::pg_catalog.text AS col,
         CASE WHEN a.atttypid IN ('pg_catalog.float4'::pg_catalog.regtype, 'pg_catalog.float8'::pg_catalog.regtype)
              THEN 'float' ELSE a.atttypid::pg_catalog.text END AS ty
  ${USER_TABLES}`;

/**
 * Taken once, at the end: everything the findings need. Domains are followed to their base type at any
 * depth, and arrays to their element type. Partitions are left out (their parent is reported),
 * inherited columns too (reported where defined), and tables that belong to an extension. For fix_sql,
 * what else may hold amounts of the column, in its table and in every partition or inheritance child
 * (an ALTER of the parent changes their column too, matched by name): the defaults; the CHECK
 * constraints, as written back (null for one that also uses another column); and whether a unique or
 * exclusion index with an expression or a WHERE clause depends on it (pg_depend). An ordinary index's
 * condition only decides which rows it speeds up, so it does not count.
 */
export const DETAIL_SQL = `
  WITH RECURSIVE descendants AS (
    SELECT i.inhparent AS root, i.inhrelid AS rel FROM pg_catalog.pg_inherits i
    UNION
    SELECT d.root, i.inhrelid FROM descendants d JOIN pg_catalog.pg_inherits i ON i.inhparent = d.rel
  ),
  cols AS (
    SELECT a.attrelid::pg_catalog.text || ':' || a.attnum::pg_catalog.text AS col,
           n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS declared, a.atttypid AS typid,
           a.attgenerated::pg_catalog.text AS generated, a.attinhcount > 0 AS inherited,
           (SELECT pg_catalog.array_agg(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid))
            FROM pg_catalog.pg_attribute fa
            JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = fa.attrelid AND ad.adnum = fa.attnum
            WHERE fa.attname = a.attname AND NOT fa.attisdropped
              AND (fa.attrelid = c.oid OR fa.attrelid IN (SELECT d.rel FROM descendants d WHERE d.root = c.oid))) AS defaults,
           (SELECT pg_catalog.array_agg(CASE WHEN pg_catalog.array_length(k.conkey, 1) = 1 THEN pg_catalog.pg_get_expr(k.conbin, k.conrelid) END)
            FROM pg_catalog.pg_attribute fa
            JOIN pg_catalog.pg_constraint k ON k.conrelid = fa.attrelid AND k.contype = 'c' AND fa.attnum = ANY (k.conkey)
            WHERE fa.attname = a.attname AND NOT fa.attisdropped
              AND (fa.attrelid = c.oid OR fa.attrelid IN (SELECT d.rel FROM descendants d WHERE d.root = c.oid))) AS checks,
           EXISTS (SELECT 1 FROM pg_catalog.pg_attribute fa
                   JOIN pg_catalog.pg_index i ON i.indrelid = fa.attrelid AND (i.indisunique OR i.indisexclusion)
                     AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL)
                   JOIN pg_catalog.pg_depend p ON p.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND p.objid = i.indexrelid
                     AND p.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND p.refobjid = fa.attrelid AND p.refobjsubid = fa.attnum
                   WHERE fa.attname = a.attname AND NOT fa.attisdropped
                     AND (fa.attrelid = c.oid OR fa.attrelid IN (SELECT d.rel FROM descendants d WHERE d.root = c.oid))) AS in_index_expr
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
           t.typname::pg_catalog.text AS base_name, tn.nspname::pg_catalog.text AS base_schema,
           t.typtype::pg_catalog.text AS base_kind
    FROM chain ch
    JOIN pg_catalog.pg_type t ON t.oid = ch.cur
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    ORDER BY ch.start, ch.depth DESC
  )
  SELECT cols.col, cols.schema_name, cols.table_name, cols.column_name, cols.declared, cols.generated, cols.inherited,
         cols.defaults, cols.checks, cols.in_index_expr,
         base.via_array, base.domain_name, base.base_name, base.base_schema, base.base_kind
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
  /** Whether the column comes from a parent table too (a child that declares it again has it as its own as well). */
  inherited: boolean;
  /** The defaults of the column, in its table and in every partition or child, as PostgreSQL writes them back ("0.00", "'0'::numeric"); null when there are none. */
  defaults: string[] | null;
  /** Each CHECK constraint on the column (in its table, partitions and children) as written back; null for one that also uses another column. Null when there are none. */
  checks: Array<string | null> | null;
  /** Whether a unique or exclusion index with an expression or a WHERE clause depends on the column, in its table or a partition or child. */
  in_index_expr: boolean;
  via_array: boolean;
  domain_name: string | null;
  base_name: string;
  base_schema: string;
  /** pg_type.typtype of the base type: 'b' base, 'c' composite, 'e' enum, ... */
  base_kind: string;
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
    'real and double precision are binary floating point: most decimal amounts (0.10, 19.99) cannot be stored exactly, and sums drift by fractions of a penny. Store integer minor units (pence, cents) in bigint: add a NEW migration with fix_sql and update the code that reads and writes the column. fix_sql takes the column to hold pounds or dollars and multiplies by 100, rounding to whole pence; when the name says the amounts are minor units already (pence, cents, minor), it only rounds. Renaming the column to <column>_pence makes the unit clear.',
  MONEY_TYPE:
    "Postgres's money type depends on the lc_monetary setting, has a fixed number of decimals and no currency, and rounds silently. Store integer minor units in bigint, with the currency in its own column. Constraints and defaults that use the money type must change in the same migration.",
  NUMERIC_MONEY:
    'numeric is exact, so this is not a rounding bug, but amounts with decimals are not integer minor units: every piece of code must round the same way. Convert to bigint minor units, or pass accept_numeric: true if numeric is a deliberate choice. fix_sql multiplies by 100 for 2 decimal places, keeps whole numbers (scale 0) as they are, and rounds to whole pence where no scale is declared; if a scale-0 column holds whole pounds rather than pence, multiply by 100 instead.',
  SMALLINT_MONEY: 'smallint holds at most 32,767 minor units (£327.67); a larger amount fails with an out-of-range error. Widen it to bigint; no data conversion is needed.',
};

/** Added to the explanation of every code that has a finding with fix_sql null in the result. */
export const NULL_FIX_NOTE =
  ' Where fix_sql is null, the change needs a decision or belongs elsewhere: a domain or array type (change the domain or the element type), a generated column (change its expression), a column a child table inherits (change it on the parent), amounts finer than a penny (choose the unit first), a default, CHECK constraint or unique index condition that may hold amounts in the old unit (convert those in the same migration: ALTER COLUMN ... TYPE does not), or a name holding hidden characters (write it by hand).';

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

/** The declared scale of a numeric column ("numeric(12,4)" gives 4), or null when none is declared. */
export function numericScale(declared: string): number | null {
  const match = /^numeric\(\d+,(-?\d+)\)$/.exec(declared);
  return match === null ? null : Number(match[1]);
}

/**
 * Whether a column default, as PostgreSQL writes it back, is zero or NULL ("0", "0.00", "'0'::numeric",
 * "(0)::numeric", "NULL::numeric"): converting the column to minor units leaves such a default right.
 * Anything else, an expression included, counts as an amount.
 */
export function isZeroOrNullDefault(expr: string): boolean {
  const value = expr
    .replace(/::[a-z][a-z ]*(?:\(\d+(?:,\d+)?\))?$/, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  return value === 'NULL' || /^-?(?:0+(?:\.0*)?|\.0+)$/.test(value);
}

/**
 * Whether a CHECK expression, as PostgreSQL writes it back, can hold no amount: no number but zero
 * ("(total >= (0)::double precision)", "IS NOT NULL") and no function call, whose result could be one.
 * Converting the column keeps such a check right; "amount <= 1000.00" or "amount <= max_total()" would
 * turn into a cap a hundred times lower.
 */
export function holdsNoAmount(expr: string): boolean {
  return !/[1-9]/.test(expr) && !/[\p{L}\p{N}_"]\(/u.test(expr);
}

/**
 * A name as PostgreSQL's quote_ident writes it: bare when it would read back as the same name (lowercase
 * letters, digits and "_", and not a keyword in `reserved`), otherwise in double quotes with any double
 * quote doubled. Done here, not by quote_ident in the database: the migrations control that database,
 * and one that replaces pg_catalog.quote_ident could write the SQL the model is told to run.
 */
export function quoteIdent(name: string, reserved: ReadonlySet<string>): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !reserved.has(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * A starting point for the fix, or null where the change belongs elsewhere or needs a decision: a
 * domain (change the domain), an array, a generated column (change its expression), a numeric column
 * finer than a minor unit (choose the unit first), or a name holding a control or invisible character
 * (results show such names escaped, and SQL built from the escaped text would name a different column).
 * The conversion follows the name: amounts already in minor units (pence, cents, minor) are only
 * rounded; anything else is taken to be in pounds or dollars and multiplied by 100. A conversion that
 * multiplies is null too while the column's default, a CHECK constraint or a unique index's condition
 * may hold an amount: ALTER COLUMN ... TYPE converts the stored rows with USING but leaves those in the
 * old unit (a default of 2.50 pounds becomes 3 pence), and the next lint could not see it. `reserved` is
 * PostgreSQL's list of keywords that must be quoted, read before any migration ran.
 */
export function fixSql(row: DetailRow, code: LintCode, reserved: ReadonlySet<string>): string | null {
  // A column a child inherits changes with its parent: ALTER refuses it on the child.
  if (row.domain_name !== null || row.via_array || row.generated !== '' || row.inherited) return null;
  if ([row.schema_name, row.table_name, row.column_name].some(hasUnsafe)) return null;
  const c = quoteIdent(row.column_name, reserved);
  const head = `ALTER TABLE ${quoteIdent(row.schema_name, reserved)}.${quoteIdent(row.table_name, reserved)} ALTER COLUMN ${c} TYPE bigint`;
  const minor = namesMinorUnits(row.column_name);
  const checkHoldsAmount = (row.checks ?? []).some((expr) => expr === null || !holdsNoAmount(expr));
  const keepsOldUnit = checkHoldsAmount || row.in_index_expr || (row.defaults ?? []).some((expr) => !isZeroOrNullDefault(expr));
  const times100 = (using: string) => (keepsOldUnit ? null : `${head} USING ${using};`);
  const convert = minor ? `${head} USING round(${c})::bigint;` : times100(`round(${c} * 100)::bigint`);
  switch (code) {
    case 'SMALLINT_MONEY':
      return `${head};`;
    case 'MONEY_TYPE':
      // The money type holds major units with 2 decimals. A default written as a money value (0::money)
      // cannot be cast to bigint, so the ALTER would fail: that one needs writing by hand.
      if ((row.defaults ?? []).some((expr) => /::money$/.test(expr))) return null;
      return times100(`(${c}::numeric * 100)::bigint`);
    case 'FLOAT_MONEY':
      return convert;
    case 'NUMERIC_MONEY': {
      const scale = numericScale(row.declared);
      if (scale === null) return convert; // no declared scale: like a float, it may hold any decimals
      if (scale <= 0) return `${head};`; // whole numbers already: keep them as they are
      return scale > (minor ? 0 : 2) ? null : convert; // finer than a minor unit: choose the unit first
    }
  }
}

/** Whether `looksLikeMoney` or the caller's lists make a column money. */
export function isMoneyColumn(row: DetailRow, listed: ReadonlySet<string>): boolean {
  return looksLikeMoney(row.column_name) || listed.has(`${row.schema_name}.${row.table_name}.${row.column_name}`);
}
