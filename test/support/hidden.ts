// The tests' own check for a raw hidden character, written apart from src/echo.ts so a test never
// trusts the code it checks: Unicode's controls (Cc), format characters (Cf, which hold the zero-width
// characters, direction marks and TAG characters), line and paragraph separators (Zl, Zp), lone
// surrogates (Cs) and default-ignorable code points (variation selectors, fillers).
export const RAW_HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** `text` spelt in Unicode TAG characters (U+E0000 + each ASCII code): invisible to a person, readable by a model. */
export function inTags(text: string): string {
  return Array.from(text, (c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join('');
}
