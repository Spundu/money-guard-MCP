// The repository practises what the server enforces: no text file holds a raw control, invisible,
// line-separator or bidirectional-override character (the "Trojan Source" trick hides what code says).
// Tests that need such a character write it as a unicode escape inside the string.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RAW_HIDDEN } from './support/hidden.js';

const REPO = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);
const TEXT = /\.(?:ts|mts|mjs|js|json|md|sql|csv|jsonl|yml|sh)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : TEXT.test(entry.name) ? [full] : [];
  });
}

/**
 * The text files of the repository: the ones git tracks (a scratch file someone keeps in their clone is
 * not the repository's), or every file outside the skipped folders where there is no git checkout.
 */
function files(): string[] {
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0');
    return tracked.filter((rel) => TEXT.test(rel)).map((rel) => path.join(REPO, rel));
  } catch {
    return walk(REPO);
  }
}

describe('the repository', () => {
  it('holds no raw hidden characters in any text file', () => {
    const offenders: string[] = [];
    for (const file of files()) {
      // Tabs and line ends are ordinary; a byte order mark is hidden (Cf), so it counts.
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (RAW_HIDDEN.test(line.replaceAll('\t', ' '))) offenders.push(`${path.relative(REPO, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
