// money_lint_schema from arguments to result (SPEC.md §3): collect the files, run them in a throwaway
// PostgreSQL, judge every column, and report. One lint runs at a time: each starts a database.

import { overBudget } from '../budget.js';
import { closest } from '../closest.js';
import { clip, escapeUnsafe } from '../echo.js';
import { ToolError } from '../errors.js';
import type { Root } from '../paths.js';
import { FIXES, NULL_FIX_NOTE, baseType, displayType, fixSql, isMoneyColumn, judge, type LintCode, type LintFinding } from './catalog.js';
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

  // An entry that names no column is a mistake to report, not a silent no-op: PostgreSQL folds unquoted
  // names to lowercase, so "Orders.GrossValue" matches nothing.
  const known = db.detail.map((r) => `${r.schema_name}.${r.table_name}.${r.column_name}`);
  const knownSet = new Set(known);
  for (const [param, set] of [['money_columns', listed], ['ignore_columns', ignored]] as const) {
    for (const entry of set) if (!knownSet.has(entry)) throw unknownColumn(param, entry, known);
  }

  const findings: LintFinding[] = [];
  const tables = new Set<string>();
  const otherFloats: string[] = [];
  let moneyChecked = 0;
  let moneyOther = 0;
  let ignoredCount = 0;
  for (const row of db.detail) {
    const since = db.since.get(row.col);
    if (since === undefined || since < 0) continue; // made by the preset or the setup file, never changed since
    const key = `${row.schema_name}.${row.table_name}.${row.column_name}`;
    const table = `${row.schema_name}.${row.table_name}`;
    tables.add(table);
    const base = baseType(row);
    const money = isMoneyColumn(row, listed);
    if (ignored.has(key)) {
      if (judge(row, money, params.accept_numeric ?? false) !== null) ignoredCount += 1;
      continue;
    }
    if (base !== null && (money || base === 'money')) moneyChecked += 1;
    else if (money) moneyOther += 1; // text, JSON, a composite: not checked (SPEC.md §6)
    const code = judge(row, money, params.accept_numeric ?? false);
    if (code !== null) {
      // Names and paths come from the project, which may be hostile: whole, but escaped (SPEC.md §2.4).
      findings.push({
        code,
        severity: code === 'FLOAT_MONEY' || code === 'MONEY_TYPE' ? 'error' : 'warning',
        table: escapeUnsafe(table),
        column: escapeUnsafe(row.column_name),
        type: escapeUnsafe(displayType(row)),
        introduced_in: escapeUnsafe(sources.files[since]?.rel ?? '?'),
        fix_sql: fixSql(row, code),
      });
    } else if (!money && (base === 'real' || base === 'double precision')) {
      otherFloats.push(escapeUnsafe(key));
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
  const withoutFix = new Set(findings.filter((f) => f.fix_sql === null).map((f) => f.code));
  for (const f of findings) fixes[f.code] = FIXES[f.code] + (withoutFix.has(f.code) ? NULL_FIX_NOTE : '');
  otherFloats.sort();
  const applied = sources.files.map((f) => escapeUnsafe(f.rel));

  const result: LintResult = {
    summary: summarise({ problems: findings.length, errors, warnings, ignored: ignoredCount, money: moneyChecked, moneyOther, tables: tables.size, floats: otherFloats.length, files: applied.length }),
    migrations: escapeUnsafe(sources.migrations),
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
  // Over the budget (long names, deep folders): shorten the listing of applied files first, then the
  // float columns, then the findings, never below one. The counts above still cover everything.
  while (result.files_applied.length > 0 && overBudget(result)) {
    result.files_applied.pop();
    result.files_applied_truncated = true;
  }
  while (result.other_float_columns.length > 0 && overBudget(result)) result.other_float_columns.pop();
  while (result.findings.length > 1 && overBudget(result)) {
    result.findings.pop();
    result.findings_truncated = true;
  }
  return result;
}

interface Counts {
  problems: number;
  errors: number;
  warnings: number;
  ignored: number;
  money: number;
  moneyOther: number;
  tables: number;
  floats: number;
  files: number;
}

function summarise(c: Counts): string {
  const applied = `${plural(c.files, 'migration file')} applied.`;
  const ignoredNote = c.ignored > 0 ? ` ${c.ignored} ignored.` : '';
  const otherNote = c.moneyOther > 0 ? ` ${plural(c.moneyOther, 'money-named column')} of text, JSON or another type ${c.moneyOther === 1 ? 'was' : 'were'} not checked.` : '';
  if (c.tables === 0) {
    // Nothing was checked: say so, as the ledger tool does for an empty file. A file that holds its own
    // down step in a format money-guard does not know would have dropped what it created.
    return `No tables exist after ${c.files === 1 ? 'the 1 migration file' : `the ${c.files} migration files`}, so nothing was checked. If a file also holds its down step, that step dropped what the file created: pass files, or lint a copy without the down steps.`;
  }
  if (c.problems > 0) {
    return `${plural(c.problems, 'problem')} in ${plural(c.problems, 'money column')} (${plural(c.errors, 'error')}, ${plural(c.warnings, 'warning')}). ${applied}${ignoredNote}${otherNote}`;
  }
  if (c.money > 0) return `No problems: ${plural(c.money, 'money column')} in ${plural(c.tables, 'table')} ${c.money === 1 ? 'uses a safe type' : 'use safe types'}. ${applied}${ignoredNote}${otherNote}`;
  const floats = c.floats > 0 ? `; ${plural(c.floats, 'float column')} in other_float_columns, in case one holds money` : '';
  return `No money columns found in ${plural(c.tables, 'table')}${floats}. ${applied}${ignoredNote}${otherNote}`;
}

function unknownColumn(param: 'money_columns' | 'ignore_columns', entry: string, known: readonly string[]): ToolError {
  const near = closest(entry, known);
  const hint = near === undefined ? '' : ` Did you mean "${clip(near, 120)}"?`;
  return new ToolError(
    'BAD_COLUMN_NAME',
    `${param} names "${clip(entry, 120)}", which is not a column of any table the migrations create.${hint}`,
    'Write each entry as the name appears in the database (PostgreSQL folds unquoted names to lowercase): table.column, or schema.table.column outside the public schema.',
  );
}
