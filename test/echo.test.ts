import { describe, expect, it } from 'vitest';
import { ECHO_MAX, clip, escapeStrings, escapeUnsafe, hasUnsafe } from '../src/echo.js';

const width = (s: string) => [...s].length;

describe('clip', () => {
  it('returns short text unchanged', () => {
    expect(clip('12.5')).toBe('12.5');
    expect(clip('')).toBe('');
  });

  it('keeps text of exactly the limit, and cuts one character more to the limit with an ellipsis', () => {
    const exact = 'x'.repeat(ECHO_MAX);
    expect(clip(exact)).toBe(exact);
    const cut = clip('x'.repeat(ECHO_MAX + 1));
    expect(cut).toBe(`${'x'.repeat(ECHO_MAX - 1)}…`);
    expect(width(cut)).toBe(ECHO_MAX);
  });

  it('never returns more than the limit, whatever the input', () => {
    for (const input of ['a'.repeat(10_000), '\u0001'.repeat(100), '😀'.repeat(100), `ab${'‮'.repeat(30)}`]) {
      expect(width(clip(input))).toBeLessThanOrEqual(ECHO_MAX);
    }
  });

  it('escapes control characters, line separators and bidi overrides so they cannot hide text', () => {
    expect(clip('a\nb')).toBe('a\\u000ab');
    expect(clip('\u001b[31m')).toBe('\\u001b[31m');
    expect(clip('x y')).toBe('x\\u2028y');
    expect(clip('abc‮dcba')).toBe('abc\\u202edcba');
    expect(clip('⁦i⁩')).toBe('\\u2066i\\u2069');
    expect(clip('\u0085')).toBe('\\u0085');
  });

  it('counts an escape as the six characters it shows', () => {
    const out = clip('\u0001'.repeat(10), 20);
    // Three escapes are 18 characters; a fourth would pass 19, the room left before the ellipsis.
    expect(out).toBe(`${'\\u0001'.repeat(3)}…`);
  });

  it('counts an astral character (an emoji) as one character, and never splits it', () => {
    expect(clip('😀😀', 2)).toBe('😀😀');
    expect(clip('😀😀😀', 2)).toBe('😀…');
  });
});

describe('escapeUnsafe, hasUnsafe and escapeStrings', () => {
  // A name from a hostile migration: the right-to-left override reverses how the text after it shows.
  const hostile = 'total_‮DANGER';
  const shown = 'total_\\u202eDANGER';

  it('escapes the same characters as clip, and cuts nothing', () => {
    expect(escapeUnsafe(`${'x'.repeat(100)}⁦`)).toBe(`${'x'.repeat(100)}\\u2066`);
    expect(escapeUnsafe(hostile)).toBe(shown);
    expect(escapeUnsafe('a\nb')).toBe(clip('a\nb'));
    expect(escapeUnsafe('plain name_1 😀')).toBe('plain name_1 😀');
  });

  it('changes nothing the second time: its escapes are plain ASCII', () => {
    expect(escapeUnsafe(shown)).toBe(shown);
    expect([hasUnsafe(hostile), hasUnsafe(shown), hasUnsafe('😀 fine')]).toEqual([true, false, false]);
  });

  it('reaches every string of a JSON value, keys included, and leaves other values alone', () => {
    const value = { summary: hostile, list: [hostile, 1, null, true], nested: { [hostile]: { x: hostile } }, n: 2 };
    expect(escapeStrings(value)).toEqual({ summary: shown, list: [shown, 1, null, true], nested: { [shown]: { x: shown } }, n: 2 });
    expect(hasUnsafe(JSON.stringify(escapeStrings(value)))).toBe(false);
  });
});
