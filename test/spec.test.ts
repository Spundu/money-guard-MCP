// SPEC.md is the contract (CLAUDE.md): the texts the model reads must be exactly the ones it states.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXES, NULL_FIX_NOTE } from '../src/lint/catalog.js';
import { AUDIT_DESCRIPTION, INSTRUCTIONS, LEDGER_DESCRIPTION, LINT_DESCRIPTION } from '../src/text.js';

const SPEC = readFileSync(path.resolve(import.meta.dirname, '..', 'SPEC.md'), 'utf8');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The first blockquote after `heading`, unwrapped, with whitespace squashed. */
function quoteAfter(heading: string): string {
  const start = SPEC.indexOf(heading);
  if (start === -1) throw new Error(`SPEC.md has no "${heading}"`);
  const lines = SPEC.slice(start).split('\n');
  const first = lines.findIndex((l) => l.trimStart().startsWith('>'));
  const quote: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.trimStart().startsWith('>')) break;
    quote.push(line.trimStart().replace(/^>\s?/, ''));
  }
  return squash(quote.join('\n'));
}

describe('SPEC.md and the code agree', () => {
  it('on the server instructions (§2.7)', () => {
    expect(quoteAfter('**Server instructions**')).toBe(squash(INSTRUCTIONS));
  });

  it.each([
    ['### 3.1 Description', LINT_DESCRIPTION],
    ['### 4.1 Description', LEDGER_DESCRIPTION],
    ['### 5.1 Description', AUDIT_DESCRIPTION],
  ])('on the tool description under "%s"', (heading, text) => {
    expect(quoteAfter(heading)).toBe(squash(text));
  });

  it('on the explanation of every lint code, and why fix_sql can be null (§3.10)', () => {
    for (const text of [...Object.values(FIXES), NULL_FIX_NOTE]) expect(squash(SPEC)).toContain(squash(text));
  });

  it('keeps every description and the instructions under the 4,096 characters a client shows (SPEC.md §1, fact 3)', () => {
    for (const text of [INSTRUCTIONS, LINT_DESCRIPTION, LEDGER_DESCRIPTION, AUDIT_DESCRIPTION]) expect(text.length).toBeLessThan(4096);
  });
});
