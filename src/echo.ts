// Data minimisation (SPEC.md §2.4): a result may repeat a piece of a file (an amount that did not
// parse, a header name), never a whole line, and never more than ECHO_MAX characters of it. Control
// characters and the invisible characters that can disguise text are escaped, so what the model reads
// is what the file holds.

/** Longest piece of file content a result may repeat, in characters (code points). */
export const ECHO_MAX = 40;

const ELLIPSIS = '…';

/**
 * True for a code point that must not reach the model raw: C0 and C1 controls, DEL, the line and
 * paragraph separators, and the bidirectional overrides and isolates (the "Trojan Source" characters).
 */
function mustEscape(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** One character as the model may see it: itself, or a six-character `\uXXXX` escape. */
function shownChar(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  return mustEscape(cp) ? `\\u${cp.toString(16).padStart(4, '0')}` : char;
}

/** True if `text` holds a character that `escapeUnsafe` and `clip` escape. */
export function hasUnsafe(text: string): boolean {
  for (const char of text) if (mustEscape(char.codePointAt(0) ?? 0)) return true;
  return false;
}

/**
 * `text` with every character that must not reach the model raw escaped, and nothing cut. For names a
 * result must show whole so the model can act on them: database identifiers (PostgreSQL caps them at
 * 63 bytes) and paths inside the project. The escapes are plain ASCII, so applying it twice changes
 * nothing.
 */
export function escapeUnsafe(text: string): string {
  return hasUnsafe(text) ? Array.from(text, shownChar).join('') : text;
}

/**
 * A JSON value with `escapeUnsafe` applied to every string in it, keys included: the server's last
 * step before anything reaches the client, so no string can arrive raw even if a field was missed.
 */
export function escapeStrings<T>(value: T): T {
  if (typeof value === 'string') return escapeUnsafe(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => escapeStrings(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [escapeUnsafe(key), escapeStrings(item)])) as T;
  }
  return value;
}

/**
 * `text` made safe to repeat in a result: escaped, then cut to at most `max` characters, `…` marking a
 * cut. An escape (`\u001b`) counts as the six characters it shows, so the bound holds for the output.
 * Only the first `max + 1` characters are ever looked at, so a huge input costs nothing extra.
 */
export function clip(text: string, max: number = ECHO_MAX): string {
  const pieces: Array<[piece: string, width: number]> = [];
  let width = 0;
  for (const char of text) {
    const shown = shownChar(char);
    const piece: [string, number] = [shown, shown === char ? 1 : 6];
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
