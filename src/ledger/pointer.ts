// RFC 6901 pointers into a parsed ledger (SPEC.md §4.2): own properties only. Split from read.ts, which
// grew past 400 lines.
import { JsonNumber } from './json.js';

const TOKENS = new Map<string, string[]>(); // decoded pointers: a call maps a few; cleared past 64

/** The value at RFC 6901 pointer `pointer` inside `doc`, or undefined. Own properties only. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let node: unknown = doc;
  // Each pointer decoded once, not for every record (review round 17: four of 200 tokens took 9 s).
  let tokens = TOKENS.get(pointer);
  if (tokens === undefined) {
    if (TOKENS.size >= 64) TOKENS.clear();
    tokens = pointer.slice(1).split('/').map(decodeToken);
    TOKENS.set(pointer, tokens);
  }
  for (const token of tokens) {
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      node = node[Number(token)];
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
}

/** One token of a pointer as the key it names: "~1" is "/", "~0" is "~" (RFC 6901). */
export function decodeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** A key as one token of a pointer: "~" and "/" escaped, as RFC 6901 says. */
export function encodeToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber);
}
