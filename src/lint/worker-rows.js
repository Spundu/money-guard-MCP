// @ts-check
// The checks the database thread makes on catalog rows before it sends them (SPEC.md §3.4). A migration
// can replace the functions the catalog queries are built with and make their results huge, which the main
// thread would keep to the end of the lint, past this thread's limits (review rounds 17 and 18); and what a
// statement's failure says of the database (brokePGlite). Kept apart
// from worker.js, which starts a database when it is loaded, so that the tests can call them directly.

/** A column's key: its table oid and column number, as PostgreSQL's own functions write them. */
const COLUMN_KEY = /^\d{1,10}:\d{1,5}$/;

/** The longest name or other short text a catalog row may hold (a PostgreSQL name is at most 63 bytes). */
export const MAX_NAME_CHARS = 512;

/** The longest expression text passed on; past it, the stand-in takes its place. */
export const MAX_TEXT_CHARS = 2000;

/** How many expression texts of a column are passed on. */
export const MAX_TEXTS = 50;

/** How many characters of expression texts are passed on in all. */
export const MAX_ALL_TEXT_CHARS = 1_000_000;

/**
 * Whether every snapshot row is a column key and a type (an oid, or "float") as PostgreSQL gives them.
 * @param {ReadonlyArray<readonly unknown[]>} rows
 */
export function saneSnapshot(rows) {
  return rows.every(([col, ty]) => typeof col === 'string' && COLUMN_KEY.test(col) && typeof ty === 'string' && /^(?:float|\d{1,10})$/.test(ty));
}

/**
 * The catalog rows with their expression texts bounded here, where a migration cannot change the code
 * (review round 17: it can replace pg_catalog.length, and an inheritance chain multiplied distinct
 * defaults to 194 million characters). A text over 2,000 characters, past the 50th of a column, or past
 * 1,000,000 characters in all is left out, and one stand-in takes the place of all a column lost, which
 * the main thread reads as possibly holding an amount: for defaults a text over 2,000 characters, for
 * CHECKs and index texts null. A value that is not text is passed on, for the main thread to refuse.
 * @param {unknown[]} rows
 */
export function bounded(rows) {
  let left = MAX_ALL_TEXT_CHARS;
  /** @param {unknown} texts @param {string | null} stand */
  const bound = (texts, stand) => {
    if (!Array.isArray(texts)) return texts;
    /** @type {unknown[]} */
    const out = [];
    let lost = false;
    for (const t of texts) {
      if (typeof t === 'string' && (t.length > MAX_TEXT_CHARS || t.length > left || out.length >= MAX_TEXTS)) {
        lost = true;
        continue;
      }
      if (typeof t === 'string') left -= t.length;
      out.push(t);
    }
    if (lost) out.push(stand);
    return out;
  };
  // Names and the column key are short in a database whose functions are PostgreSQL's own; one that is
  // not sends a row the main thread refuses as a value of the wrong kind, not the text. A type's text is
  // cut instead, as a result shows it cut (review round 18: a replaced textcat or format_type made them
  // huge, past this thread's limits once the main thread held them).
  const EXPRESSIONS = ['defaults', 'checks', 'index_exprs'];
  const TYPES = ['declared', 'domain_name'];
  const sane = (/** @type {Record<string, unknown>} */ row) =>
    typeof row.col === 'string' && COLUMN_KEY.test(row.col) && Object.entries(row).every(([k, v]) => EXPRESSIONS.includes(k) || TYPES.includes(k) || typeof v !== 'string' || v.length <= MAX_NAME_CHARS);
  if (!rows.every((r) => sane(/** @type {Record<string, unknown>} */ (r)))) return [null];
  /** @param {unknown} v */
  const short = (v) => (typeof v === 'string' && v.length > MAX_NAME_CHARS ? v.slice(0, MAX_NAME_CHARS) : v);
  return rows.map((r) => {
    const row = /** @type {Record<string, unknown>} */ (r);
    return { ...row, declared: short(row.declared), domain_name: short(row.domain_name), defaults: bound(row.defaults, 'x'.repeat(MAX_TEXT_CHARS + 1)), checks: bound(row.checks, null), index_exprs: bound(row.index_exprs, null) };
  });
}

/**
 * Whether a statement's failure is PGlite's own JavaScript failing, not PostgreSQL refusing it: then the
 * database no longer answers correctly (review round 24: under a client encoding set by set_config, a
 * failing statement on a name that is not ASCII gave "r is not a function", reported as the statement
 * refused). A TypeError or a RangeError (a stack overflow, a string too long) is no answer of PostgreSQL's.
 * @param {unknown} err
 */
export function brokePGlite(err) {
  return err instanceof TypeError || err instanceof RangeError;
}
