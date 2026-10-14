// The repository practises what the server enforces: no text file holds a raw control, line-separator
// or bidirectional-override character (the "Trojan Source" trick hides what code says). Tests that need
// such a character write it as a unicode escape inside the string.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasUnsafe } from '../src/echo.js';

const REPO = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);
const TEXT = /\.(?:ts|mts|mjs|js|json|md|sql|csv|jsonl|yml|sh)$/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : TEXT.test(entry.name) ? [full] : [];
  });
}

describe('the repository', () => {
  it('holds no raw hidden characters in any text file', () => {
    const offenders: string[] = [];
    for (const file of files(REPO)) {
      // Tabs and line ends are ordinary; a byte order mark is hidden, so it counts.
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (hasUnsafe(line.replaceAll('\t', ' ')) || line.includes('\ufeff')) offenders.push(`${path.relative(REPO, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
