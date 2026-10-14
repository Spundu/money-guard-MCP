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

/**
 * `text` made safe to repeat in a result: escaped, then cut to at most `max` characters, `…` marking a
 * cut. An escape (`\u001b`) counts as the six characters it shows, so the bound holds for the output.
 * Only the first `max + 1` characters are ever looked at, so a huge input costs nothing extra.
 */
export function clip(text: string, max: number = ECHO_MAX): string {
  const pieces: Array<[piece: string, width: number]> = [];
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const piece: [string, number] = mustEscape(cp) ? [`\\u${cp.toString(16).padStart(4, '0')}`, 6] : [char, 1];
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
