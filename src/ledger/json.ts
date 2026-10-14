// A strict RFC 8259 JSON parser for ledger exports, adapted from sealed-audit-chain's parseJson (same
// author, MIT). It differs in one way: a number comes back as a JsonNumber holding the exact text the
// file wrote, never as a 64-bit float. A float would round 4503599627370496.5 to a whole number and
// 1234567890123456789 to 1234567890123456800, so a fractional amount would pass as whole pence and two
// transaction ids would merge.
//
// Like sealed-audit-chain's parser it never calls JSON.parse: V8 12.9 and later (Node 23 to at least 26)
// can return the wrong key for an escaped one-character key, depending on what the process parsed
// before. Duplicate keys resolve last-wins, "__proto__" is an ordinary key, nesting is limited, and the
// parser uses no regular expressions (a regex compiled when the stack is nearly full can fail).

export class JsonSyntaxError extends Error {
  override name = 'JsonSyntaxError';
}

/** A JSON number exactly as written in the file (RFC 8259 syntax, already checked). */
export class JsonNumber {
  constructor(readonly text: string) {}

  toString(): string {
    return this.text;
  }
}

const QUOTE = 34;
const BACKSLASH = 92;
const SIMPLE_ESCAPES: Readonly<Record<number, string>> = {
  34: '"',
  92: String.fromCharCode(92),
  47: '/',
  98: String.fromCharCode(8),
  102: String.fromCharCode(12),
  110: String.fromCharCode(10),
  114: String.fromCharCode(13),
  116: String.fromCharCode(9),
};

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** The value of one hex digit, or -1 if `code` is not one (either case). */
function hexValue(code: number): number {
  if (isDigit(code)) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

class Parser {
  #pos = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parse(): unknown {
    this.#skipWhitespace();
    const value = this.#value(0);
    this.#skipWhitespace();
    if (this.#pos !== this.text.length) this.#fail('unexpected trailing characters');
    return value;
  }

  #fail(message: string): never {
    throw new JsonSyntaxError(`${message} at position ${this.#pos}`);
  }

  #skipWhitespace(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.#pos);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return;
      this.#pos += 1;
    }
  }

  #expectWord(word: string): void {
    if (!this.text.startsWith(word, this.#pos)) this.#fail('unexpected token');
    this.#pos += word.length;
  }

  #value(depth: number): unknown {
    const c = this.text.charCodeAt(this.#pos);
    if (c === QUOTE) return this.#string();
    if (c === 123 /* { */ || c === 91 /* [ */) {
      if (depth >= this.maxDepth) this.#fail(`nesting deeper than ${this.maxDepth}`);
      return c === 123 ? this.#object(depth) : this.#array(depth);
    }
    if (c === 116 /* t */) return this.#expectWord('true'), true;
    if (c === 102 /* f */) return this.#expectWord('false'), false;
    if (c === 110 /* n */) return this.#expectWord('null'), null;
    return this.#number();
  }

  #digits(message: string): void {
    if (!isDigit(this.text.charCodeAt(this.#pos))) this.#fail(message);
    while (isDigit(this.text.charCodeAt(this.#pos))) this.#pos += 1;
  }

  // RFC 8259: number = [ "-" ] ( "0" / 1-9 *DIGIT ) [ "." 1*DIGIT ] [ ( "e" / "E" ) [ "+" / "-" ] 1*DIGIT ]
  #number(): JsonNumber {
    const start = this.#pos;
    if (this.text.charCodeAt(this.#pos) === 45 /* - */) this.#pos += 1;
    if (this.text.charCodeAt(this.#pos) === 48 /* 0 */) this.#pos += 1;
    else this.#digits('unexpected token');
    if (this.text.charCodeAt(this.#pos) === 46 /* . */) {
      this.#pos += 1;
      this.#digits('invalid number');
    }
    const e = this.text.charCodeAt(this.#pos);
    if (e === 101 /* e */ || e === 69 /* E */) {
      this.#pos += 1;
      const sign = this.text.charCodeAt(this.#pos);
      if (sign === 43 /* + */ || sign === 45 /* - */) this.#pos += 1;
      this.#digits('invalid number');
    }
    return new JsonNumber(this.text.slice(start, this.#pos));
  }

  #string(): string {
    this.#pos += 1; // opening quote
    let out = '';
    let runStart = this.#pos;
    for (;;) {
      const c = this.text.charCodeAt(this.#pos);
      if (Number.isNaN(c)) this.#fail('unterminated string');
      if (c === QUOTE) {
        out += this.text.slice(runStart, this.#pos);
        this.#pos += 1;
        return out;
      }
      if (c < 0x20) this.#fail('raw control character in string');
      if (c !== BACKSLASH) {
        this.#pos += 1;
        continue;
      }
      out += this.text.slice(runStart, this.#pos);
      const escape = this.text.charCodeAt(this.#pos + 1);
      const simple = SIMPLE_ESCAPES[escape];
      if (simple !== undefined) {
        out += simple;
        this.#pos += 2;
      } else if (escape === 117 /* u */) {
        let code = 0;
        for (let k = 2; k < 6; k += 1) {
          const digit = hexValue(this.text.charCodeAt(this.#pos + k));
          if (digit < 0) this.#fail('invalid unicode escape');
          code = code * 16 + digit;
        }
        out += String.fromCharCode(code);
        this.#pos += 6;
      } else {
        this.#fail('invalid escape');
      }
      runStart = this.#pos;
    }
  }

  #array(depth: number): unknown[] {
    this.#pos += 1;
    const out: unknown[] = [];
    this.#skipWhitespace();
    if (this.text.charCodeAt(this.#pos) === 93 /* ] */) {
      this.#pos += 1;
      return out;
    }
    for (;;) {
      this.#skipWhitespace();
      out.push(this.#value(depth + 1));
      this.#skipWhitespace();
      const c = this.text.charCodeAt(this.#pos);
      this.#pos += 1;
      if (c === 93 /* ] */) return out;
      if (c !== 44 /* , */) this.#fail('expected , or ]');
    }
  }

  #object(depth: number): Record<string, unknown> {
    this.#pos += 1;
    const out: Record<string, unknown> = {};
    this.#skipWhitespace();
    if (this.text.charCodeAt(this.#pos) === 125 /* } */) {
      this.#pos += 1;
      return out;
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.text.charCodeAt(this.#pos) !== QUOTE) this.#fail('expected a string key');
      const key = this.#string();
      this.#skipWhitespace();
      if (this.text.charCodeAt(this.#pos) !== 58 /* : */) this.#fail('expected :');
      this.#pos += 1;
      this.#skipWhitespace();
      // defineProperty, not assignment: "__proto__" must become an own member, and a duplicate key
      // simply redefines it (last wins).
      Object.defineProperty(out, key, { value: this.#value(depth + 1), writable: true, enumerable: true, configurable: true });
      this.#skipWhitespace();
      const c = this.text.charCodeAt(this.#pos);
      this.#pos += 1;
      if (c === 125 /* } */) return out;
      if (c !== 44 /* , */) this.#fail('expected , or }');
    }
  }
}

/** Parse JSON text strictly (RFC 8259), numbers as JsonNumber. Throws JsonSyntaxError ("... at position N"). */
export function parseLedgerJson(text: string, maxDepth: number): unknown {
  return new Parser(text, maxDepth).parse();
}

/** How far a number's decimal point may move, either way, before it counts as too large or too small. */
const MAX_POINT_SHIFT = 400;

/**
 * An exponent with more digits than this moves the decimal point further than any mantissa that fits
 * in memory can move it back; up to it, the arithmetic below is exact (it stays under 2^53).
 */
const MAX_EXPONENT_DIGITS = 15;

/**
 * The exact value of a JSON number as plain decimal text, without an exponent or redundant zeros: "1e3"
 * is "1000", "12.50" is "12.5", "-0.0" is "0", "4503599627370496.5" stays as it is. "too large" or "too
 * small" when the decimal point would end up more than MAX_POINT_SHIFT digits from the first
 * significant digit (1e400, 1e-402; 1e-401 is 401 decimal places):
 * such text would cost more than any amount or id is worth. Linear in the length of the text: zeros are
 * counted with loops, never with a regular expression, which would backtrack through a long run of them.
 */
export function plainDecimal(number: JsonNumber): string | 'too large' | 'too small' {
  const text = number.text;
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const e = Math.max(body.indexOf('e'), body.indexOf('E'));
  const mantissa = e === -1 ? body : body.slice(0, e);
  const exponentText = e === -1 ? '0' : body.slice(e + 1);
  const dot = mantissa.indexOf('.');
  const whole = dot === -1 ? mantissa : mantissa.slice(0, dot);
  const fraction = dot === -1 ? '' : mantissa.slice(dot + 1);

  const all = whole + fraction;
  let leading = 0;
  while (leading < all.length && all.charCodeAt(leading) === 48 /* 0 */) leading += 1;
  let end = all.length;
  while (end > leading && all.charCodeAt(end - 1) === 48) end -= 1;
  if (leading === end) return '0';
  const digits = all.slice(leading, end);

  // Bound the exponent's text before turning it into a number: "1e99999999999999999999" is legal JSON.
  const sign = exponentText.startsWith('-') ? -1 : 1;
  let first = /^[+-]/.test(exponentText) ? 1 : 0;
  while (first < exponentText.length - 1 && exponentText.charCodeAt(first) === 48) first += 1;
  const exponent = exponentText.length - first > MAX_EXPONENT_DIGITS ? sign * Infinity : sign * Number(exponentText.slice(first));
  const point = whole.length - leading + exponent; // where the decimal point falls within `digits`
  if (point > MAX_POINT_SHIFT) return 'too large';
  if (point < -MAX_POINT_SHIFT) return 'too small';

  let plain: string;
  if (point <= 0) plain = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + '0'.repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${plain}` : plain;
}
