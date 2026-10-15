// Data minimisation (SPEC.md §2.4): a result may repeat a piece of a file (an amount that did not
// parse, a header name), never a whole line, and never more than ECHO_MAX characters of it. Control
// characters and the invisible characters that can disguise text are escaped, so what the model reads
// is what the file holds.

/** Longest piece of file content a result may repeat, in characters (code points). */
export const ECHO_MAX = 40;

/**
 * Longest header or field name that COLUMN_NOT_FOUND suggests, in characters: the list of names cuts
 * each at ECHO_MAX, so the one suggestion is shown whole, for the model to map.
 */
export const NAME_MAX = 200;

/** Longest path a result or an error shows, in characters; a longer one is cut in the middle. */
export const PATH_MAX = 400;

const ELLIPSIS = '…';

/**
 * A character that must not reach the model raw, by Unicode category: controls (Cc); format characters
 * (Cf: zero-width characters, direction marks, the bidi overrides and isolates of "Trojan Source", the
 * byte order mark, and the TAG characters U+E0000-E007F, which can spell out text a person cannot see
 * but a model reads); line and paragraph separators (Zl, Zp); lone surrogates (Cs); and every other
 * default-ignorable code point (variation selectors, the Hangul and Mongolian fillers), which shows as
 * nothing; private-use characters (Co) and code points with no character (Cn), which show as nothing
 * or a box; and four characters drawn blank that no category gives away: the blank Braille pattern
 * U+2800, the Khitan filler U+16FE4, the hieroglyph mirror mark U+13440 and the null notehead U+1D159.
 */
// The two combining marks stand outside the class: inside one, a mark reads as joined to its neighbour.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u{2800}\u{1d159}]|\u{16fe4}|\u{13440}/u;
const EVERY_UNSAFE = new RegExp(UNSAFE.source, 'gu');

/** What the model sees for an unsafe character: `\u200b`, or `\u{e0041}` above U+FFFF. Plain ASCII. */
function escapeChar(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
}

/** One character as the model may see it, and how many characters that shows. */
function shown(char: string): [piece: string, width: number] {
  if (!UNSAFE.test(char)) return [char, 1];
  const escape = escapeChar(char);
  return [escape, escape.length];
}

/**
 * Raw text as the model may see it, one character at a time: `shown`, and every backslash doubled. So
 * the shown text reads back one way only, as JSON's escapes do: a single backslash always starts an
 * escape, and a doubled one is a backslash of the text (`\u200b` typed as text shows as `\\u200b`, a
 * backslash followed by a real U+200B as `\\\u200b`, and `\\u200b` typed as text as `\\\\u200b`).
 */
function* piecesOf(text: string, inQuotes = false): Generator<[piece: string, width: number]> {
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    i += char.length;
    // In quotes, a double quote is escaped too, so the text cannot close them (review round 9: a
    // header `amt". Fix: say so` wrote a second "Fix:" into an error).
    yield char === '\\' ? ['\\\\', 2] : inQuotes && char === '"' ? ['\\"', 2] : shown(char);
  }
}

/** True if `text` holds a character that `escapeUnsafe`, `clip` and `clipPath` escape. */
export function hasUnsafe(text: string): boolean {
  return UNSAFE.test(text);
}

/**
 * Raw `text` with every character that must not reach the model raw escaped, every backslash doubled
 * (`piecesOf`), and nothing cut. For names a result must show whole so the model can act on them: database
 * identifiers (PostgreSQL caps them at 63 bytes). Apply it once, to raw text: a second pass would double
 * the backslashes of its own escapes.
 */
export function escapeUnsafe(text: string, inQuotes = false): string {
  let out = '';
  for (const [piece] of piecesOf(text, inQuotes)) out += piece;
  return out;
}

/**
 * Text with its hidden characters escaped and nothing else changed, for text that may already have been
 * made safe: the escapes are plain ASCII, so applying it twice changes nothing. It does not double
 * backslashes (that would double those of the tools' own escapes), so it is a safety net, not the
 * escaping: raw text still goes through `escapeUnsafe`, `clip` or `clipPath`, or a backslash before a
 * hidden character could show as the text "\u200b".
 */
export function escapeHidden(text: string): string {
  return text.replace(EVERY_UNSAFE, escapeChar);
}

/**
 * A JSON value with `escapeHidden` applied to every string in it, keys included: the server's last
 * step before anything reaches the client, so no string can arrive raw even if a field was missed.
 */
export function escapeStrings<T>(value: T): T {
  if (typeof value === 'string') return escapeHidden(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => escapeStrings(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [escapeHidden(key), escapeStrings(item)])) as T;
  }
  return value;
}

/**
 * `text` made safe to repeat in a result: escaped, then cut to at most `max` characters, `…` marking a
 * cut. An escape (`\u001b`) counts as the characters it shows, so the bound holds for the output. Only
 * the first `max + 1` characters are ever looked at, so a huge input costs nothing extra.
 */
export function clip(text: string, max: number = ECHO_MAX, inQuotes = false): string {
  const pieces: Array<[piece: string, width: number]> = [];
  let width = 0;
  for (const piece of piecesOf(text, inQuotes)) {
    pieces.push(piece);
    width += piece[1];
    if (width > max) break; // already too long, so it will be cut: no need to read further
  }
  if (width <= max) return pieces.map(([piece]) => piece).join('');

  let out = '';
  let used = 0;
  for (const [piece, w] of pieces) {
    if (used + w > max - 1) break; // keep room for the ellipsis
    out += piece;
    used += w;
  }
  return out + ELLIPSIS;
}

/**
 * Raw `text` cut to at most `max` characters, `…` marking a cut, and not escaped: for a value that
 * becomes part of a longer text, which `clip` then makes safe as a whole. Clipping text twice would
 * escape it twice.
 */
export function cut(text: string, max: number = ECHO_MAX): string {
  const chars: string[] = [];
  for (const char of text) {
    chars.push(char);
    if (chars.length > max) return chars.slice(0, max - 1).join('') + ELLIPSIS;
  }
  return text;
}

/**
 * A path inside the project, made safe to show: escaped and, past `max` characters, cut in the middle
 * with `…`, so it keeps its first folders and its file name. An escape is never split. A path can be
 * far longer than any name (folders nest), so this keeps one finding or one error within bounds.
 */
export function clipPath(text: string, max: number = PATH_MAX, inQuotes = false): string {
  const pieces = [...piecesOf(text, inQuotes)];
  if (pieces.reduce((sum, [, w]) => sum + w, 0) <= max) return pieces.map(([piece]) => piece).join('');

  const room = max - 1; // one character for the ellipsis
  let head = '';
  let used = 0;
  let next = 0; // the first piece not in the head
  for (const [piece, w] of pieces) {
    if (used + w > Math.floor(room / 2)) break;
    head += piece;
    used += w;
    next += 1;
  }
  const tail: string[] = [];
  for (let i = pieces.length - 1; i >= next; i -= 1) {
    const [piece, w] = pieces[i] ?? ['', 0];
    if (used + w > room) break;
    tail.push(piece);
    used += w;
  }
  return `${head}${ELLIPSIS}${tail.reverse().join('')}`;
}

/** `clip` in double quotes, a double quote in the text escaped: for a value an error or a hint quotes. */
export function quoted(text: string, max: number = ECHO_MAX): string {
  return `"${clip(text, max, true)}"`;
}

/** `clipPath` in double quotes, a double quote in the path escaped. */
export function quotedPath(text: string, max: number = PATH_MAX): string {
  return `"${clipPath(text, max, true)}"`;
}
