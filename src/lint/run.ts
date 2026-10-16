// money_lint_schema from arguments to result (SPEC.md §3): collect the files, run them in a throwaway
// PostgreSQL, judge every column, and report. One lint runs at a time: each starts a database.

import { overBudget } from '../budget.js';
import { closest } from '../closest.js';
import { clip, clipPath, escapeUnsafe, quoted, quotedPath } from '../echo.js';
import { ToolError } from '../errors.js';
import type { Root } from '../paths.js';
import { ExpressionReader } from './amounts.js';
import { FIXES, NULL_FIX_NOTE, baseType, displayType, fixSql, isMoneyColumn, judge, type DetailRow, type LintCode, type LintFinding } from './catalog.js';
import { runScripts, type Script } from './database.js';
import { collectSources } from './files.js';
import { SUPABASE_PRESET } from './supabase.js';

/** Under the 60 seconds a client built on the MCP TypeScript SDK waits by default (its DEFAULT_REQUEST_TIMEOUT_MSEC), so the model sees TIMEOUT and not a client error. */
export const DEFAULT_TIMEOUT_SECONDS = 45;
const MAX_FINDINGS = 50;
const MAX_LISTED = 30;

/** Ends the summary when not every finding is in the result (review round 11: the lint has pages now). */
const NOT_ALL_LISTED = ' Not every finding is listed (findings_truncated): pass next_offset as offset for the next ones.';

/**
 * How the summary ends for a page: the next page while there is one; on a later page with none after
 * it, which findings these are, so that nothing tells the model to pass a next_offset that is null
 * (review round 12: on the last page it said so, and an offset of null starts again from the first).
 */
function pageNote(offset: number, shown: number, total: number, next: number | null): string {
  if (next !== null) return NOT_ALL_LISTED;
  if (offset === 0 || total === 0) return '';
  const n = (x: number) => x.toLocaleString('en-GB');
  if (shown === 1) return ` This is finding ${n(offset + 1)} of ${n(total)}, the last.`;
  return shown > 0 ? ` These are findings ${n(offset + 1)}-${n(offset + shown)} of ${n(total)}, the last.` : ` No findings from offset ${n(offset)}: there ${total === 1 ? 'is' : 'are'} ${n(total)}.`;
}
/** Longest column type a finding shows: a schema-qualified domain and its base type fit. */
const MAX_TYPE_CHARS = 200;

export interface LintParams {
  migrations: string;
  files?: readonly string[] | undefined;
  preset?: 'supabase' | undefined;
  setup?: string | undefined;
  accept_numeric?: boolean | undefined;
  money_columns?: readonly string[] | undefined;
  ignore_columns?: readonly string[] | undefined;
  timeout_seconds?: number | undefined;
  offset?: number | undefined;
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
  /** Where the next findings start (pass it as offset), or null when none come after these. */
  next_offset: number | null;
  other_float_columns: string[];
  other_float_columns_count: number;
  fixes: Partial<Record<LintCode, string>>;
}

/** Each entry by its full name (schema.table.column), mapped to the entry as the caller wrote it, for errors. */
function columnSet(entries: readonly string[] | undefined, param: string): Map<string, string> {
  const set = new Map<string, string>();
  for (const entry of entries ?? []) {
    const parts = entry.split('.').map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) {
      throw new ToolError('BAD_COLUMN_NAME', `${param} entry ${quoted(entry, 80)} is not "table.column" or "schema.table.column".`, 'Write each column as table.column (schema public) or schema.table.column, as the names appear in the database.');
    }
    set.set(parts.length === 2 ? `public.${parts.join('.')}` : parts.join('.'), entry);
  }
  return set;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;
}

let busy = false;

const BUSY_FIX = 'Call again when the running lint has finished: usually a few seconds, but at most its time limit (45 seconds unless it set timeout_seconds).';

/**
 * The ledger and audit tools call this first. While a lint runs they answer BUSY: each holds the main
 * thread for seconds, and the lint's memory limit is checked there, so a migration could otherwise grow
 * by gigabytes before it is stopped.
 */
export function refuseWhileLinting(): void {
  if (busy) throw new ToolError('BUSY', 'A schema lint is running; this check is refused until it ends, so that the lint\'s memory limit keeps being checked.', BUSY_FIX);
}

export async function lintSchema(root: Root, params: LintParams, signal?: AbortSignal): Promise<LintResult> {
  if (busy) {
    throw new ToolError('BUSY', 'Another schema lint is running; each one starts a database, so they run one at a time.', BUSY_FIX);
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
  const listedNames: ReadonlySet<string> = new Set(listed.keys());
  const ignored = columnSet(params.ignore_columns, 'ignore_columns');
  const sources = collectSources(root, params);

  const scripts: Script[] = [];
  if (params.preset === 'supabase') scripts.push({ name: 'the Supabase preset', text: SUPABASE_PRESET, phase: 'setup' });
  if (sources.setup) scripts.push({ name: quotedPath(sources.setup.rel), text: sources.setup.text, phase: 'setup' });
  for (const f of sources.files) scripts.push({ name: quotedPath(f.rel), text: f.text, phase: 'migration' });

  const db = await runScripts(scripts, {
    timeoutMs: (params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    preset: params.preset !== undefined,
    filesGiven: params.files !== undefined,
    setupGiven: sources.setup !== null,
    single: sources.single,
    signal,
  });

  // An entry that names no column is a mistake to report, not a silent no-op: PostgreSQL folds unquoted
  // names to lowercase, so "Orders.GrossValue" matches nothing. Only columns the migrations made or
  // changed are checked, so an entry naming a column of setup or the preset is a mistake too.
  const keyOf = (r: DetailRow) => `${r.schema_name}.${r.table_name}.${r.column_name}`;
  const known = db.detail.filter((r) => (db.since.get(r.col) ?? -1) >= 0).map(keyOf);
  const knownSet = new Set(known);
  const fromSetup = new Set(db.detail.map(keyOf));
  for (const [param, set] of [['money_columns', listed], ['ignore_columns', ignored]] as const) {
    for (const [entry, given] of set) if (!knownSet.has(entry)) throw unknownColumn(param, entry, given, known, fromSetup.has(entry));
  }

  const reader = new ExpressionReader(); // one budget for every expression this lint reads
  const findings: LintFinding[] = [];
  const tables = new Set<string>();
  const moneyTables = new Set<string>(); // the tables that hold a money column whose type was judged
  const otherFloats: string[] = [];
  let moneyChecked = 0;
  let moneyOther = 0;
  let ignoredCount = 0;
  let ignoredMoney = 0; // money columns ignore_columns left out, with a finding or not
  for (const row of db.detail) {
    const since = db.since.get(row.col);
    if (since === undefined || since < 0) continue; // made by the preset or the setup file, never changed since
    const key = `${row.schema_name}.${row.table_name}.${row.column_name}`;
    const table = `${row.schema_name}.${row.table_name}`;
    tables.add(table);
    const base = baseType(row);
    const money = isMoneyColumn(row, listedNames);
    if (ignored.has(key)) {
      if (judge(row, money, params.accept_numeric ?? false) !== null) ignoredCount += 1;
      if (money || base === 'money') ignoredMoney += 1;
      continue;
    }
    if (base !== null && (money || base === 'money')) {
      moneyChecked += 1;
      moneyTables.add(table);
    }
    else if (money && canHoldAmount(row)) moneyOther += 1; // text, JSON, a composite: not checked (SPEC.md §6)
    const code = judge(row, money, params.accept_numeric ?? false);
    if (code !== null) {
      // Names and paths come from the project, which may be hostile: escaped, and a path cut in the
      // middle past PATH_MAX characters, so one finding always fits the budget (SPEC.md §2.4).
      findings.push({
        code,
        severity: code === 'FLOAT_MONEY' || code === 'MONEY_TYPE' ? 'error' : 'warning',
        table: escapeUnsafe(table),
        column: escapeUnsafe(row.column_name),
        // format_type writes it, and a migration can replace that function: cut like any outside text.
        type: clip(displayType(row), MAX_TYPE_CHARS),
        introduced_in: clipPath(sources.files[since]?.rel ?? '?'),
        fix_sql: fixSql(row, code, db.reserved, listedNames, reader),
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
  const applied = sources.files.map((f) => clipPath(f.rel));

  // A page of findings: they are sorted, and the lint gives the same result for the same files.
  const offset = params.offset ?? 0;
  const page = findings.slice(offset, offset + MAX_FINDINGS);
  const result: LintResult = {
    summary: summarise({ problems: findings.length, errors, warnings, ignored: ignoredCount, ignoredMoney, money: moneyChecked, moneyTables: moneyTables.size, moneyOther, tables: tables.size, setupTables: db.detail.length > 0, floats: otherFloats.length, files: applied.length, single: sources.single }),
    migrations: clipPath(sources.migrations),
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
    findings: page,
    findings_truncated: findings.length > 0 && (offset > 0 || findings.length > offset + page.length), // none to cut on a clean schema (round 13)
    next_offset: findings.length > offset + page.length ? offset + page.length : null,
    other_float_columns: otherFloats.slice(0, MAX_LISTED),
    other_float_columns_count: otherFloats.length,
    fixes,
  };
  // The summary ends with what this page is; set again whenever the page is cut below.
  const base = result.summary;
  const noteThePage = () => {
    result.summary = base + pageNote(offset, result.findings.length, findings.length, result.next_offset);
  };
  noteThePage();
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
    result.next_offset = offset + result.findings.length; // the next page starts where this one was cut
    noteThePage();
  }
  return result;
}

interface Counts {
  problems: number;
  errors: number;
  warnings: number;
  ignored: number;
  /** Money columns that ignore_columns left out, whatever their type. */
  ignoredMoney: number;
  money: number;
  moneyTables: number;
  moneyOther: number;
  tables: number;
  /** Whether tables exist that setup or the preset made (and no migration changed). */
  setupTables: boolean;
  floats: number;
  files: number;
  /** Whether migrations is one file: files cannot pick from it. */
  single: boolean;
}

function summarise(c: Counts): string {
  const applied = `${plural(c.files, 'migration file')} applied.`;
  const ignoredNote = c.ignored > 0 ? ` ${c.ignored} ignored.` : '';
  const otherNote = c.moneyOther > 0 ? ` ${plural(c.moneyOther, 'money-named column')} of text, JSON or another type ${c.moneyOther === 1 ? 'was' : 'were'} not checked.` : '';
  if (c.tables === 0) {
    // Nothing was checked: say so, as the ledger tool does for an empty file. A file that holds its own
    // down step in a format money-guard does not know would have dropped what it created.
    const ran = c.files === 1 ? 'the 1 migration file' : `the ${c.files} migration files`;
    if (c.setupTables) return `Nothing was checked: every table that exists after ${ran} comes from setup or the preset (a partition counts as part of its parent).`;
    if (c.single) return 'No tables exist after the migration file, so nothing was checked. If it also holds its down step, that step dropped what the file created: lint a copy without the down step.';
    return `No tables exist after ${ran}, so nothing was checked. If a file also holds its down step, that step dropped what the file created: pass files, or lint a copy without the down steps.`;
  }
  // Float columns the name rule did not take for money are where money it misses would be: say so
  // wherever the summary would otherwise read as all clear.
  // Round 21: past 30, say which are listed: no parameter pages through the rest.
  const floatsNote = c.floats > 0 ? ` ${plural(c.floats, c.money > 0 ? 'other float column' : 'float column')} (other_float_columns${c.floats > MAX_LISTED ? `, the first ${MAX_LISTED} listed` : ''}): check that none holds money.` : '';
  if (c.problems > 0) {
    return `${plural(c.problems, 'problem')} in ${plural(c.problems, 'money column')} (${plural(c.errors, 'error')}, ${plural(c.warnings, 'warning')}). ${applied}${ignoredNote}${otherNote}${floatsNote}`;
  }
  if (c.money > 0) return `No problems: ${plural(c.money, 'money column')} in ${plural(c.moneyTables, 'table')} ${c.money === 1 ? 'uses a safe type' : 'use safe types'}. ${applied}${ignoredNote}${otherNote}${floatsNote}`;
  // Ignored columns and money-named columns of other types were money columns too: say what was not found.
  const which = c.moneyOther > 0 ? 'No money columns of a number type' : 'No money columns';
  return `${which} ${c.ignoredMoney > 0 ? 'left to check' : 'found'} in ${plural(c.tables, 'table')}. ${applied}${ignoredNote}${otherNote}${floatsNote}`;
}

/** Money-named columns of these types hold amounts the lint does not check: text, JSON, a composite, an extension's type (citext). Not booleans, dates or ids. */
function canHoldAmount(row: DetailRow): boolean {
  if (row.base_schema === 'pg_catalog') return ['text', 'varchar', 'bpchar', 'json', 'jsonb'].includes(row.base_name);
  return row.base_kind === 'c' || row.base_kind === 'b';
}

function unknownColumn(param: 'money_columns' | 'ignore_columns', entry: string, given: string, known: readonly string[], madeBySetup: boolean): ToolError {
  if (madeBySetup) {
    return new ToolError(
      'BAD_COLUMN_NAME',
      `${param} names ${quoted(given, 120)}, a column that setup or the preset creates: only columns the migrations create or change are checked.`,
      'Leave the entry out: setup and the preset stand for what your platform provides, and their columns are not checked.',
    );
  }
  // Within the table the entry names, compare the column names alone: whole names share their schema
  // and table, and only their first 64 characters are compared (review round 10: a long table name made
  // every column look alike). A table the migrations do not create: compare whole names.
  const tableOf = (name: string) => name.slice(0, name.lastIndexOf('.') + 1).toLowerCase();
  const columnOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);
  const same = known.filter((k) => tableOf(k) === tableOf(entry));
  const column = same.length > 0 ? closest(columnOf(entry), same.map(columnOf)) : undefined;
  const near = same.length > 0 ? same.find((k) => columnOf(k) === column) : closest(entry, known);
  // "public.orders" read as table.column is the public schema's table "orders" (review round 11).
  const table = known.some((k) => k.toLowerCase().startsWith(`${given.trim().toLowerCase()}.`)) ? ' That is a table: name one of its columns.' : '';
  const hint = table || (near === undefined ? '' : ` Did you mean "${escapeUnsafe(near, true)}"?`); // a database name: whole, as findings show it, a quote escaped
  return new ToolError(
    'BAD_COLUMN_NAME',
    `${param} names ${quoted(given, 120)}, which is not a column of any table the migrations create.${hint}`,
    `Write each entry as the name appears in the database (PostgreSQL folds unquoted names to lowercase): table.column, or schema.table.column outside the public schema. Name an inherited column by the table that defines it, and a partition's column by its parent table.${near?.includes('\\') === true ? ' Write each backslash once: results show it doubled.' : ''}`, // round 17
  );
}
