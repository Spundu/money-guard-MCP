// Where the rows of a CSV file start, and how wide they may be (SPEC.md §4.8): counted on the raw bytes,
// before and after csv-parse reads them. Split from read.ts, which grew past 400 lines.

/**
 * The most characters of values one CSV row may hold (delimiters aside). A ledger row holds a few hundred;
 * a row of 25 MiB (13 million one-character fields) took 15 seconds to read on a busy machine.
 */
export const MAX_ROW_CHARS = 1024 * 1024;

/**
 * The most fields one CSV row may hold. MAX_ROW_CHARS counts no delimiters, so a row of 26 million empty
 * fields passed it and took 11 seconds to read (review round 9); a ledger row holds a few dozen.
 */
export const MAX_FIELDS = 10_000;

/**
 * The line of the first row with more than MAX_FIELDS fields, found before csv-parse reads the file:
 * delimiters outside quotes, counted per record (a line break inside quotes does not end one). Null when
 * every row is within the limit, or the delimiter is not one ASCII character.
 */
export function rowWithTooManyFields(bytes: Uint8Array, delimiter: string): number | null {
  const d = delimiter.length === 1 ? delimiter.charCodeAt(0) : 0x80;
  if (d >= 0x80) return null;
  let quoted = false;
  let fields = 1;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    // A line ends at LF, or at a CR that no LF follows, as startLines counts them.
    if (b === 0x0a || (b === 0x0d && bytes[i + 1] !== 0x0a)) line += 1;
    if (b === 0x22) quoted = !quoted;
    else if (quoted) continue;
    else if (b === d) {
      fields += 1;
      if (fields > MAX_FIELDS) return rowLine;
    } else if (b === 0x0a || b === 0x0d) {
      fields = 1;
      rowLine = line;
    }
  }
  return null;
}

/**
 * The 1-based line each record starts on. csv-parse's own line count is wrong for a quoted field that
 * holds a CRLF line break (it counts the CR as a line too), but its byte offsets are exact, so lines
 * are counted here: line feeds before the record's first character, blank lines skipped.
 */
export function startLines(bytes: Uint8Array, ends: readonly number[]): number[] {
  // A line ends at LF, or at a CR that no LF follows (CR-only files, as old Mac Excel writes them).
  const endsLine = (i: number) => bytes[i] === 0x0a || (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a);
  const lines: number[] = [];
  let pos = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = pos; i < to; i += 1) if (endsLine(i)) line += 1;
    pos = to;
  };
  for (const end of ends) {
    // The record starts on the first line with something other than spaces and tabs.
    let start = pos;
    for (let j = pos; j < end; j += 1) {
      if (endsLine(j)) start = j + 1;
      else if (bytes[j] !== 0x20 && bytes[j] !== 0x09 && bytes[j] !== 0x0d) break;
    }
    advance(start);
    lines.push(line);
    advance(end);
  }
  return lines;
}
