// SPEC.md is the contract (CLAUDE.md): the texts the model reads must be exactly the ones it states, and
// the example results it shows must be what the tools return.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_KEY_HEX, SHOP } from '../scripts/fixtures.mjs';
import { verifyAuditLog } from '../src/audit/verify.js';
import { parseAuditKeys } from '../src/config.js';
import { checkLedgerFile } from '../src/ledger/run.js';
import { FIXES, NULL_FIX_NOTE } from '../src/lint/catalog.js';
import { RULE_WORDS, SUB_LISTS, WORD_LISTS, moneyByGuess } from '../src/lint/names.js';
import { lintSchema } from '../src/lint/run.js';
import { AUDIT_DESCRIPTION, INSTRUCTIONS, LEDGER_DESCRIPTION, LINT_DESCRIPTION } from '../src/text.js';
import type { ToolError } from '../src/errors.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

const SPEC = readFileSync(path.resolve(import.meta.dirname, '..', 'SPEC.md'), 'utf8');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The JSON blocks of the section that starts at `heading`, parsed (our own document, so JSON.parse). */
function jsonBlocksAfter(heading: string): unknown[] {
  const start = SPEC.indexOf(heading);
  if (start === -1) throw new Error(`SPEC.md has no "${heading}"`);
  const end = SPEC.indexOf('\n### ', start + heading.length);
  const section = SPEC.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] ?? 'null') as unknown);
}

/** The example with each shortened hash ("0f1de47f…") turned into "starts with these characters". */
function withShortenedHashes(value: unknown): unknown {
  if (typeof value === 'string' && value.endsWith('…')) return expect.stringMatching(new RegExp(`^${value.slice(0, -1)}[0-9a-f]+$`));
  if (Array.isArray(value)) return value.map(withShortenedHashes);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withShortenedHashes(v)]));
  return value;
}

/** Every key path of a JSON value, in order: the examples must list fields in the order results do. */
function keyOrder(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keyOrder(v, `${at}/${i}`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${at}/${k}`, ...keyOrder(v, `${at}/${k}`)]);
  return [];
}

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

describe('SPEC.md §3.8', () => {
  it('shows a MIGRATION_FAILED error exactly as the lint writes it', async () => {
    const example = /\*\*Example\*\*[^`]*`(MIGRATION_FAILED:[^`]*)`/.exec(SPEC.slice(SPEC.indexOf('### 3.8')))?.[1] ?? 'no example';
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0004_rls.sql': 'create table orders (id bigint);\n\ngrant select on public.orders to authenticated;\n' });
    const err = await lintSchema(rootOf(dir), { migrations: 'db/migrations' }).then(
      () => undefined,
      (e: unknown) => e as ToolError,
    );
    expect(squash(err?.toText() ?? 'no error')).toBe(squash(example));
  });
});

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

  it('on the example results of §3.10, §4.9 and §5.8, which are what the tools return on fixtures/shop', async () => {
    const root = rootOf(SHOP);
    const keys = parseAuditKeys(`k1=${FIXTURE_KEY_HEX}`);
    if (!keys.ok) throw new Error(keys.error.toText());
    const audit = (file: string) => verifyAuditLog({ file, bytes: readFileSync(path.join(SHOP, file)), keys: keys.value });
    const pairs: Array<[unknown, unknown]> = [
      [await lintSchema(root, { migrations: 'db/migrations' }), jsonBlocksAfter('### 3.10 Example')[0]],
      [checkLedgerFile(root, { file: 'exports/journal.csv', columns: { transaction_id: 'txn_id', amount: 'amount_pence', currency: 'currency' } }), jsonBlocksAfter('### 4.9 Example')[0]],
      [audit('logs/audit.jsonl'), jsonBlocksAfter('### 5.8 Example')[0]],
      [audit('logs/audit-tampered.jsonl'), jsonBlocksAfter('### 5.8 Example')[1]],
    ];
    for (const [actual, shown] of pairs) {
      expect(shown).toBeDefined();
      expect(actual).toEqual(withShortenedHashes(shown));
      expect(keyOrder(actual)).toEqual(keyOrder(shown));
    }
  });

  it('keeps every description and the instructions under the 4,096 characters a client shows (SPEC.md §1, fact 3)', () => {
    for (const text of [INSTRUCTIONS, LINT_DESCRIPTION, LEDGER_DESCRIPTION, AUDIT_DESCRIPTION]) expect(text.length).toBeLessThan(4096);
  });

  it('on every word list of the name rule (§3.5), word for word', () => {
    // Review round 7: words added to the code in round 6 never reached the SPEC lists.
    const section = SPEC.slice(SPEC.indexOf('### 3.5'), SPEC.indexOf('### 3.6'));
    const lines = section.split('\n');
    for (const [label, words] of Object.entries(WORD_LISTS)) {
      const first = lines.findIndex((line) => line.startsWith(`- **${label}`));
      expect(first, label).toBeGreaterThan(-1);
      const end = lines.findIndex((line, i) => i > first && !/^\s+\S/.test(line));
      // Each list, or each sub-list, follows a colon outside brackets; a sentence after it is prose.
      const parts = lines.slice(first, end).join(' ').replace(/^- \*\*[^*]+\*\*/, '').replace(/\([^)]*\)/g, '').split(/\s+-\s+/);
      const listed = parts.flatMap((part) => (part.includes(':') ? (part.split(':')[1] ?? '') : part).split(/[.;](?:\s|$)/)[0]?.split(',') ?? []).map((w) => w.trim().replace(/^and /, '')).filter((w) => w !== '');
      expect(listed.filter((w) => !/^[a-z0-9]+$/.test(w)), label).toEqual([]);
      expect([...new Set(listed)].sort(), label).toEqual([...words].sort());
    }
    // Review round 9: the sub-lists the rule before total uses, each with its own set.
    for (const [name, set] of Object.entries(SUB_LISTS)) {
      const first = lines.findIndex((line) => line.startsWith(`  - ${name}:`));
      expect(first, name).toBeGreaterThan(-1);
      const end = lines.findIndex((line, i) => i > first && !line.startsWith('    '));
      const listed = lines.slice(first, end).join(' ').slice(`  - ${name}:`.length).split(',').map((w) => w.trim());
      expect(listed.sort(), name).toEqual([...set].sort());
    }
    // Review round 8: each prose list, word for word, between the words around it.
    const prose = section.replace(/\s+/g, ' ');
    const around: Record<string, [string, string]> = {
      ratio: ['ends in a ratio word (', ')'],
      payRate: ['"rate" after ', ' is the price'],
      priced: ['"rate per" an ', ' ('],
      value: ['**"value"** after ', ' is what'],
      held: ['measure word, or one of ', ', between'], // review round 18
      heldGuess: ['are money. With ', ' there'],
      budgetHeld: ['generic money words, or one of ', ', stands there'], // review round 19
      heldAfter: ['`overtime_balance`), or one of ', ' after it'],
      pricedMeasure: ['before a last word of ', ' (`price_kg`'],
    };
    for (const [key, set] of Object.entries(RULE_WORDS)) {
      const [before, after] = around[key] ?? ['', ''];
      const start = prose.indexOf(before);
      expect(start, key).toBeGreaterThan(-1);
      const list = prose.slice(start + before.length, prose.indexOf(after, start + before.length));
      expect(list.split(/,\s*|\s+or\s+/).sort(), key).toEqual([...set].sort());
    }
  });

  it('cites as guesses only names the rule takes for guesses (SPEC, README and the fixes text)', () => {
    // Review round 11: total_deposited, cited as a guess, had become money in round 10, and before it
    // total_mileage a measure in round 9. Each sentence that speaks of a guess is checked.
    const README = readFileSync(path.resolve(import.meta.dirname, '..', 'README.md'), 'utf8');
    const sentences = [SPEC, README, NULL_FIX_NOTE].join('\n').replace(/\s+/g, ' ').split(/(?<=[.;]) /).filter((t) => /by a guess|may not be money/.test(t));
    const cited = sentences
      .flatMap((t) => [...t.matchAll(/`([a-z][a-z0-9_]*)`|\((\w+): if it is/g)].map((m) => m[1] ?? m[2] ?? ''))
      .filter((name) => !['fix_sql', 'null', 'money_columns', 'ignore_columns'].includes(name));
    expect(cited.length).toBeGreaterThanOrEqual(5);
    expect(cited.filter((name) => !moneyByGuess(name))).toEqual([]);
  });
});
