// Whether a default, a CHECK or an index condition, as PostgreSQL writes it back, can hold an amount of
// the column (SPEC.md §3.6): fix_sql that multiplies by 100 is withheld beside one that may. These run on
// the server's main thread, past the time limit's reach, so each reads its text in time that grows with
// its length, and none reads more than MAX_EXPR_CHARS. Split from catalog.ts, which grew past 400 lines.

/**
 * Whether a column default, as PostgreSQL writes it back, is zero or NULL ("0", "0.00", "'0'::numeric",
 * "(0)::numeric", "NULL::numeric"): converting the column to minor units leaves such a default right.
 * Anything else, an expression included, counts as an amount.
 */
export function isZeroOrNullDefault(expr: string): boolean {
  // Each pass below reads the whole text, on the main thread: a default of 2,000 nested casts (134,000
  // characters) took 364 ms, and 300 such columns 137 s (review round 11). A zero is short.
  if (expr.length > MAX_EXPR_CHARS) return false;
  // Casts and brackets come off one at a time: "('0'::numeric)::double precision" is zero too.
  let value = expr;
  for (let previous = ''; previous !== value; ) {
    previous = value;
    value = value
      .replace(/::[a-z][a-z ]*(?:\(\d+(?:,\d+)?\))?$/, '')
      .replace(/^\((.*)\)$/, '$1')
      .replace(/^'(.*)'$/, '$1');
  }
  return value === 'NULL' || /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(value);
}

/**
 * Whether a CHECK expression or an index's condition, as PostgreSQL writes it back, can hold no amount:
 * no number but zero ("(total >= (0)::double precision)", "IS NOT NULL") and no function call, whose
 * result could be one. Converting the column keeps such a condition right; "amount <= 1000.00" or
 * "amount <= max_total()" would turn into a cap a hundred times lower. Digits in a name ("q1_revenue")
 * or a type's size ("0::numeric(10,2)") are not amounts, and neither are the places of a two-decimal
 * guard: "total = round(total, 2)" and "scale(total) <= 2" hold for pence as they did for pounds. A
 * cast of the column to a bounded type ("amount::numeric(5,2) = amount", "amount::smallint") is a cap,
 * and a guard of fewer places ("round(total, 0)", "scale(total) = 0") stops guarding after the fix.
 */
export function holdsNoAmount(expr: string): boolean {
  // The patterns below run on the server's main thread, past the time limit's reach: a long text could
  // hold it for hours (review round 10: 120,000 characters took 35 s). A CHECK that long may hold anything.
  if (expr.length > MAX_EXPR_CHARS) return false;
  if (castsToBoundedType(expr)) return false;
  // A pattern over the amount's text ("price::text ~ '^\d+\.\d\d$'") checks its form in pounds (review round 11).
  // PostgreSQL writes every pattern back with ~: LIKE as ~~, ILIKE as ~~*, SIMILAR TO as ~ similar_to_escape().
  if (expr.includes('~')) return false;
  // The whole row ("t.* IS NOT NULL") holds the amount too (review round 12).
  if (expr.includes('.*')) return false;
  const rest = expr
    // A quoted name, or a string literal, read left to right, so a quote inside one cannot start the
    // other. A literal that holds digits ('1000.00'::numeric, a date) keeps them: it may be an amount.
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (token) => (token.startsWith("'") && /\d/.test(token) ? token.slice(1, -1) : 'x'))
    .replace(/::[a-z][a-z ]*(?:\(\d+(?:,\d+)?\))?(?:\[\])?/g, '') // a cast and its type's size
    // round(x, 2): places, two or more. round(x, 0) guards whole pounds, which pence would not keep.
    .replace(/\b(?:round|trunc)\(((?:[^()]|\([^()]*\))*),\s*(?:[2-9]|[1-9]\d+)\)/g, '($1)')
    // scale(x) <= 2 or < 3: places, at least two. "= 2" would fail for every bigint, and "= 0" or
    // "<= 1" would stop guarding once the column holds pence.
    .replace(/\bscale\(((?:[^()]|\([^()]*\))*)\)\s*(?:<=\s*(?:[2-9]|[1-9]\d+)|<\s*(?:[3-9]|[1-9]\d+))(?![\d.])/g, '($1)')
    .replace(/\b[a-z_][a-z0-9_$]*\b(?!\s*\()/gi, 'x'); // a bare name, which may hold digits
  return !/[1-9]/.test(rest) && !/[\p{L}\p{N}_"]\(/u.test(rest);
}

/** Longest CHECK or index expression `holdsNoAmount` reads; a real one is a few dozen characters. */
const MAX_EXPR_CHARS = 2000;

/** A cast type that bounds the value: a size (numeric(5,2), varchar(5): a text of fixed length) or a small integer type. */
const BOUNDED_TYPE = /(?:numeric|decimal|character varying|varchar|character|char|bpchar|bit varying|varbit|bit)\(\d|(?:smallint|integer|int|int2|int4|bigint|int8)\b/y;

/**
 * Whether the expression casts anything but a number to a bounded type ("amount::numeric(5,2) =
 * amount", "(amount)::smallint"): a cap. Each "::" is read once, and its operand found by looking back
 * from it, so the time grows with the length (a pattern over the whole text grew with its square).
 */
function castsToBoundedType(expr: string): boolean {
  for (let at = expr.indexOf('::'); at >= 0; at = expr.indexOf('::', at + 2)) {
    BOUNDED_TYPE.lastIndex = at + 2;
    if (!BOUNDED_TYPE.test(expr)) continue;
    let start = at;
    if (expr[at - 1] === ')') {
      // A bracketed operand: back to its opening bracket.
      for (let depth = 0, i = at - 1; i >= 0; i -= 1) {
        if (expr[i] === ')') depth += 1;
        else if (expr[i] === '(' && --depth === 0) {
          start = i;
          break;
        }
      }
    } else {
      while (start > 0 && /[\w.$"']/.test(expr[start - 1] ?? '')) start -= 1;
    }
    if (!/^\(?'?-?[\d.]*'?\)?$/.test(expr.slice(start, at))) return true;
  }
  return false;
}

/** The most characters of expressions one lint reads in all, the same text once (review round 12). */
export const MAX_LINT_EXPR_CHARS = 1_000_000;

/**
 * Reads the expressions of one lint: each distinct text once, and at most MAX_LINT_EXPR_CHARS in all.
 * Each is capped at 2,000 characters, but not how many there are: 24,300 defaults from 80 inherited
 * tables held the main thread 20 s (review round 12). Past the budget an expression counts as one that
 * may hold an amount, so the fix is withheld.
 */
export class ExpressionReader {
  #left = MAX_LINT_EXPR_CHARS;
  readonly #known = new Map<string, boolean>();

  holdsNoAmount(expr: string): boolean {
    return this.#read(`c${expr}`, expr, holdsNoAmount);
  }

  isZeroOrNullDefault(expr: string): boolean {
    return this.#read(`d${expr}`, expr, isZeroOrNullDefault);
  }

  #read(key: string, expr: string, judge: (text: string) => boolean): boolean {
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    if (expr.length > this.#left) return false;
    this.#left -= expr.length;
    const answer = judge(expr);
    this.#known.set(key, answer);
    return answer;
  }
}
