// money_lint_schema from arguments to result (SPEC.md §3): collect the files, run them in a throwaway
// PostgreSQL, judge every column, and report. One lint runs at a time: each starts a database.

import { clip } from '../echo.js';
import { ToolError } from '../errors.js';
import type { Root } from '../paths.js';
import { FIXES, baseType, displayType, fixSql, isMoneyColumn, judge, type LintCode, type LintFinding } from './catalog.js';
import { runScripts, type Script } from './database.js';
import { collectSources } from './files.js';
import { SUPABASE_PRESET } from './supabase.js';

export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_FINDINGS = 50;
const MAX_LISTED = 30;

export interface LintParams {
  migrations: string;
  files?: readonly string[] | undefined;
  preset?: 'supabase' | undefined;
  setup?: string | undefined;
  accept_numeric?: boolean | undefined;
  money_columns?: readonly string[] | undefined;
  ignore_columns?: readonly string[] | undefined;
  timeout_seconds?: number | undefined;
}

export interface LintResult {
  summary: string;
  migrations: string;
  migrations_sha256: string;
  postgres: string;
  files_applied_count: number;
  files_applied: string[];
  files_applied_truncated: boolean;
  tables_checked: number;
  money_columns_checked: number;
  error_count: number;
  warning_count: number;
  ignored_count: number;
  findings: LintFinding[];
  findings_truncated: boolean;
  other_float_columns: string[];
  other_float_columns_count: number;
  fixes: Partial<Record<LintCode, string>>;
}

/** "table.column" (schema public) or "schema.table.column", normalised to the three-part form. */
function columnSet(entries: readonly string[] | undefined, param: string): Set<string> {
  const set = new Set<string>();
  for (const entry of entries ?? []) {
    const parts = entry.split('.').map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) {
      throw new ToolError('BAD_COLUMN_NAME', `${param} entry "${clip(entry, 80)}" is not "table.column" or "schema.table.column".`, 'Write each column as table.column (schema public) or schema.table.column, as the names appear in the database.');
    }
    set.add(parts.length === 2 ? `public.${parts.join('.')}` : parts.join('.'));
  }
  return set;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

let busy = false;

export async function lintSchema(root: Root, params: LintParams, signal?: AbortSignal): Promise<LintResult> {
  if (busy) {
    throw new ToolError('BUSY', 'Another schema lint is running; each one starts a database, so they run one at a time.', 'Call again when the running lint has finished (usually a few seconds).');
  }
  busy = true;
  try {
    return await lint(root, params, signal);
  } finally {
    busy = false;
  }
}

async function lint(root: Root, params: LintParams, signal: AbortSignal | undefined): Promise<LintResult> {
  const listed = columnSet(params.money_columns, 'money_columns');
  const ignored = columnSet(params.ignore_columns, 'ignore_columns');
  const sources = collectSources(root, params);

  const scripts: Script[] = [];
  if (params.preset === 'supabase') scripts.push({ name: 'the Supabase preset', text: SUPABASE_PRESET, phase: 'setup' });
  if (sources.setup) scripts.push({ name: sources.setup.rel, text: sources.setup.text, phase: 'setup' });
  for (const f of sources.files) scripts.push({ name: f.rel, text: f.text, phase: 'migration' });

  const db = await runScripts(scripts, {
    timeoutMs: (params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    preset: params.preset !== undefined,
    signal,
  });

  const findings: LintFinding[] = [];
  const tables = new Set<string>();
  const otherFloats: string[] = [];
  let moneyChecked = 0;
  let ignoredCount = 0;
  for (const row of db.detail) {
    const since = db.since.get(row.col);
    if (since === undefined || since < 0) continue; // made by the preset or the setup file, never changed since
    const key = `${row.schema_name}.${row.table_name}.${row.column_name}`;
    tables.add(`${row.schema_name}.${row.table_name}`);
    const base = baseType(row);
    const money = isMoneyColumn(row, listed);
    if (ignored.has(key)) {
      if (judge(row, money, params.accept_numeric ?? false) !== null) ignoredCount += 1;
      continue;
    }
    if (money || base === 'money') moneyChecked += 1;
    const code = judge(row, money, params.accept_numeric ?? false);
    if (code !== null) {
      findings.push({
        code,
        severity: code === 'FLOAT_MONEY' || code === 'MONEY_TYPE' ? 'error' : 'warning',
        table: `${row.schema_name}.${row.table_name}`,
        column: row.column_name,
        type: displayType(row),
        introduced_in: sources.files[since]?.rel ?? '?',
        fix_sql: fixSql(row, code),
      });
    } else if (!money && (base === 'real' || base === 'double precision')) {
      otherFloats.push(key);
    }
  }

  findings.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      (a.table < b.table ? -1 : a.table > b.table ? 1 : 0) ||
      (a.column < b.column ? -1 : a.column > b.column ? 1 : 0),
  );
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const fixes: Partial<Record<LintCode, string>> = {};
  for (const f of findings) fixes[f.code] = FIXES[f.code];
  otherFloats.sort();
  const applied = sources.files.map((f) => f.rel);

  return {
    summary: summarise(findings.length, errors, warnings, ignoredCount, moneyChecked, tables.size, otherFloats.length, applied.length),
    migrations: sources.migrations,
    migrations_sha256: sources.sha256,
    postgres: db.postgres,
    files_applied_count: applied.length,
    files_applied: applied.slice(0, MAX_LISTED),
    files_applied_truncated: applied.length > MAX_LISTED,
    tables_checked: tables.size,
    money_columns_checked: moneyChecked,
    error_count: errors,
    warning_count: warnings,
    ignored_count: ignoredCount,
    findings: findings.slice(0, MAX_FINDINGS),
    findings_truncated: findings.length > MAX_FINDINGS,
    other_float_columns: otherFloats.slice(0, MAX_LISTED),
    other_float_columns_count: otherFloats.length,
    fixes,
  };
}

function summarise(problems: number, errors: number, warnings: number, ignored: number, money: number, tables: number, floats: number, files: number): string {
  const applied = `${plural(files, 'migration file')} applied.`;
  const ignoredNote = ignored > 0 ? ` ${ignored} ignored.` : '';
  if (problems > 0) {
    return `${plural(problems, 'problem')} in ${plural(problems, 'money column')} (${plural(errors, 'error')}, ${plural(warnings, 'warning')}). ${applied}${ignoredNote}`;
  }
  if (money > 0) return `No problems: ${plural(money, 'money column')} in ${plural(tables, 'table')} use safe types. ${applied}${ignoredNote}`;
  const floats_ = floats > 0 ? `; ${plural(floats, 'float column')} in other_float_columns, in case one holds money` : '';
  return `No money columns found in ${plural(tables, 'table')}${floats_}. ${applied}${ignoredNote}`;
}
