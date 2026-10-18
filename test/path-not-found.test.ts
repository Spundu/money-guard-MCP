// What a PATH_NOT_FOUND says the nearest existing folder holds (SPEC.md §2.3, §6): a live test (2026-10-18)
// had a model with no tool to list files guess four export names and give up.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInRoot, type PathRule } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

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
  it("lists its folders and the files of the tool's types, never a secret, in code-unit order", () => {
    const base = tempDir();
    writeTree(path.join(base, 'project'), {
      'exports/journal.csv': 'x',
      'exports/Bank.json': 'x',
      'exports/q3/a.csv': 'x',
      'exports/notes.txt': 'x',
      'exports/.env': 'SECRET=1',
      'exports/aws_credentials.csv': 'x',
      'exports/schema.sql': 'x',
    });
    const root = rootOf(path.join(base, 'project'));
    expect(messageOf(() => resolveInRoot(root, 'exports/ledger.csv', LEDGER))).toBe(
      '"exports/ledger.csv" does not exist. The nearest existing folder is "exports", which holds: "Bank.json", "journal.csv", "q3/".',
    );
    // The migrations tool's own type: .sql files and folders.
    expect(messageOf(() => resolveInRoot(root, 'exports/migrations', MIGRATIONS))).toBe(
      '"exports/migrations" does not exist. The nearest existing folder is "exports", which holds: "q3/", "schema.sql".',
    );
  });

  it('shows at most 20, each cut at 40 characters, and counts the rest; and says so when it holds none', () => {
    const base = tempDir();
    const long = `${'a'.repeat(60)}.csv`;
    writeTree(path.join(base, 'project'), {
      ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`exports/e${String(i).padStart(2, '0')}.csv`, 'x'])),
      [`exports/${long}`]: 'x',
      'empty/readme.txt': 'x',
    });
    const root = rootOf(path.join(base, 'project'));
    const text = messageOf(() => resolveInRoot(root, 'exports/x.csv', LEDGER));
    expect(text).toContain(`which holds: "${'a'.repeat(39)}…", "e00.csv", `);
    expect(text).toMatch(/"e18\.csv" and 5 more\.$/);
    expect(messageOf(() => resolveInRoot(root, 'empty/x.csv', LEDGER))).toBe('"empty/x.csv" does not exist. The nearest existing folder is "empty", which holds no folder and no .csv, .json, .jsonl file.');
  });
});
