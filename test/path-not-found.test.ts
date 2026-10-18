// What a PATH_NOT_FOUND says the nearest existing folder holds (SPEC.md §2.3, §6): a live test (2026-10-18)
// had a model with no tool to list files guess four export names and give up.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInRoot, type PathRule } from '../src/paths.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

const LEDGER: PathRule = { kind: 'file', extensions: ['.csv', '.json', '.jsonl'] };
const MIGRATIONS: PathRule = { kind: 'either', extensions: ['.sql'] };

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  return 'no error';
};

describe('PATH_NOT_FOUND names what the nearest folder holds', () => {
  it("lists its folders and the files of the tool's types, never a secret or a credential folder, in code-unit order", () => {
    const base = tempDir();
    writeTree(path.join(base, 'project'), {
      'exports/journal.csv': 'x',
      'exports/Bank.json': 'x',
      'exports/a.csv': 'x',
      'exports/q3/a.csv': 'x',
      'exports/notes.txt': 'x',
      'exports/.env': 'SECRET=1',
      'exports/aws_credentials.csv': 'x',
      'exports/.aws/config': 'x',
      'exports/.AWS-keep/x.sql': 'x',
      'exports/schema.sql': 'x',
    });
    const root = rootOf(path.join(base, 'project'));
    // "Bank.json" before "a.csv": code units, not the case-blind order NTFS lists them in (review round 25).
    expect(messageOf(() => resolveInRoot(root, 'exports/ledger.csv', LEDGER))).toBe(
      '"exports/ledger.csv" does not exist. The nearest existing folder is "exports", which holds: ".AWS-keep/", "Bank.json", "a.csv", "journal.csv", "q3/".',
    );
    // The migrations tool's own type: .sql files and folders.
    expect(messageOf(() => resolveInRoot(root, 'exports/migrations', MIGRATIONS))).toBe(
      '"exports/migrations" does not exist. The nearest existing folder is "exports", which holds: ".AWS-keep/", "q3/", "schema.sql".',
    );
  });

  it('never lists a link, to a file or to a folder', ({ skip }) => {
    const base = tempDir();
    writeTree(base, { 'outside/stolen.csv': 'x', 'outside/dir/a.csv': 'x', 'project/exports/real.csv': 'x' });
    const exports = path.join(base, 'project', 'exports');
    const dirLink = trySymlink(path.join(base, 'outside', 'dir'), path.join(exports, 'linked'), 'dir');
    const fileLink = trySymlink(path.join(base, 'outside', 'stolen.csv'), path.join(exports, 'link.csv'), 'file');
    if (!dirLink && !fileLink) skip('SKIPPED LOUDLY: this OS refuses to make links here');
    expect(messageOf(() => resolveInRoot(rootOf(path.join(base, 'project')), 'exports/x.csv', LEDGER))).toBe(
      '"exports/x.csv" does not exist. The nearest existing folder is "exports", which holds: "real.csv".',
    );
  });

  it('shows names whole, so one can be passed back; at most 20, and counts the rest; and says so when it holds none', () => {
    const base = tempDir();
    const long = 'Stripe_balance_transactions_2026-10-01_to_2026-10-31.csv';
    const folder = 'a-very-long-folder-name-for-quarterly-exports-2026';
    writeTree(path.join(base, 'project'), {
      ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`exports/e${String(i).padStart(2, '0')}.csv`, 'x'])),
      [`exports/${long}`]: 'x',
      [`exports/${folder}/a.csv`]: 'x',
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`twenty/t${String(i).padStart(2, '0')}.csv`, 'x'])),
      'empty/readme.txt': 'x',
    });
    const root = rootOf(path.join(base, 'project'));
    const text = messageOf(() => resolveInRoot(root, 'exports/x.csv', LEDGER));
    expect(text).toContain(`which holds: "${long}", "${folder}/", "e00.csv", `);
    expect(text).toMatch(/"e17\.csv" and 6 more\.$/);
    expect(resolveInRoot(root, `exports/${long}`, LEDGER).rel).toBe(`exports/${long}`);
    // Exactly 20: all shown, nothing more.
    expect(messageOf(() => resolveInRoot(root, 'twenty/x.csv', LEDGER))).toMatch(/"t19\.csv"\.$/);
    expect(messageOf(() => resolveInRoot(root, 'empty/x.csv', LEDGER))).toBe('"empty/x.csv" does not exist. The nearest existing folder is "empty", which holds no folder and no .csv, .json, .jsonl file.');
  });

  it('suggests the closest name, also one past the first 20, only when the last name alone is missing', () => {
    const base = tempDir();
    writeTree(path.join(base, 'project'), {
      ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`exports/f${i + 1}.csv`, 'x'])),
      'exports/journal.csv': 'x',
    });
    const root = rootOf(path.join(base, 'project'));
    const text = messageOf(() => resolveInRoot(root, 'exports/jornal.csv', LEDGER));
    expect(text).not.toContain('"journal.csv"');
    expect(text).toMatch(/ and 6 more\. Did you mean "exports\/journal\.csv"\?$/);
    expect(messageOf(() => resolveInRoot(root, 'exports/jornal/x.csv', LEDGER))).toMatch(/ and 6 more\.$/);
    expect(messageOf(() => resolveInRoot(root, 'exports/ledger.csv', LEDGER))).toMatch(/ and 6 more\.$/);
  });

  it('reads at most 10,000 entries, and says when some were left unread', () => {
    const base = tempDir();
    const exports = path.join(base, 'project', 'exports');
    writeTree(exports, { 'e00000.csv': '' });
    for (let i = 1; i < 10_000; i += 1) writeFileSync(path.join(exports, `e${String(i).padStart(5, '0')}.csv`), '');
    const root = rootOf(path.join(base, 'project'));
    // Exactly 10,000, all read.
    expect(messageOf(() => resolveInRoot(root, 'exports/x.csv', LEDGER))).toMatch(/"e00019\.csv" and 9980 more\.$/);
    expect(messageOf(() => resolveInRoot(root, 'exports/x.sql', MIGRATIONS))).toMatch(/, which holds no folder and no \.sql file\.$/);
    writeFileSync(path.join(exports, 'e10000.csv'), '');
    expect(messageOf(() => resolveInRoot(root, 'exports/x.csv', LEDGER))).toMatch(/"e\d{5}\.csv" and at least 9980 more\.$/);
    expect(messageOf(() => resolveInRoot(root, 'exports/x.sql', MIGRATIONS))).toMatch(/, whose first 10,000 entries hold no folder and no \.sql file\.$/);
  });
});
