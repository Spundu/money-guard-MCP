// The entries of files and the type of each path a lint is given (SPEC.md §3.3, §3.8): what an agent is
// told when it writes one the way it should not. Split from lint-failures.test.ts, which reached 400 lines
// (review round 19).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSources } from '../src/lint/files.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

describe('money_lint_schema: entries of files and file types', () => {
  it('says to leave out the migrations folder from an entry of files written from the project root', () => {
    // Review round 16: a likely mistake, answered only with "Check the spelling".
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': 'select 1;' });
    const e = (() => { try { collectSources(rootOf(dir), { migrations: 'db/migrations', files: ['db/migrations/0001.sql'] }); } catch (err) { return err as { toText(): string }; } return undefined; })();
    expect(e?.toText()).toBe('FILE_NOT_IN_FOLDER: "db/migrations/0001.sql" is not a file in "db/migrations". Fix: Every entry of files is a path relative to "db/migrations": leave out the leading "db/migrations/".');
    // Review round 17: not for the root itself ("./0002.sql"), nor for a sibling folder's name.
    const fix = (migrations: string, entry: string) => { try { collectSources(rootOf(dir), { migrations, files: [entry] }); } catch (err) { return (err as { fix: string }).fix; } return ''; };
    expect([fix('.', './0002.sql'), fix('db/migrations', 'db/migrations_old/0001.sql')].map((f) => f.includes('leave out'))).toEqual([false, false]);
    // Round 18: nor when the shorter path is not a file either; a migration written as code is told what to do.
    expect(fix('db/migrations', 'db/migrations/0002.sql')).toContain('Check the spelling');
    // Round 20: nor when the entry only starts with the folder's name ("db_0001.sql" is not "db/0001.sql").
    expect(fix('db/migrations', 'db/migrations_0001.sql')).toContain('Check the spelling');
    // Round 19: the shorter path is looked up only inside the folder: a file outside, reached by ".." or an
    // absolute path, never changes the answer (it told whether any file, pipe or share existed).
    writeTree(dir, { 'outside.sql': 'select 1;', 'p/db/migrations/0001.sql': 'select 1;' });
    const out = (entry: string) => { try { collectSources(rootOf(path.join(dir, 'p')), { migrations: 'db/migrations', files: [entry] }); } catch (err) { return (err as { fix: string }).fix; } return ''; };
    expect(['db/migrations/../../../outside.sql', `db/migrations/${path.join(dir, 'outside.sql').replaceAll('\\', '/')}`].map(out).filter((f) => f.includes('leave out'))).toEqual([]);
    writeTree(dir, { 'db/migrations/0003_init.ts': 'export {}' });
    const ts = (() => { try { collectSources(rootOf(dir), { migrations: 'db/migrations/0003_init.ts' }); } catch (err) { return (err as { fix: string }).fix; } return ''; })();
    expect(ts).toMatch(/^Pass a folder of \.sql migrations, or one \.sql file, .* Migrations written as code \(Knex, TypeORM\) need SQL first/);
  });

  it('gives the advice for code to migrations only, and names a files entry as it was written', () => {
    // Review round 19: setup and every entry of files were told to pass a folder of .sql migrations.
    const dir = tempDir();
    writeTree(dir, { 'mig/0001.sql': 'select 1;', 'mig/0002.ts': 'export {}', 'seed.ts': 'export {}' });
    const failed = (args: { migrations: string; setup?: string; files?: string[] }) => { try { collectSources(rootOf(dir), args); } catch (err) { return (err as { toText(): string }).toText(); } return ''; };
    expect(failed({ migrations: 'mig/0002.ts' })).toMatch(/^FILE_TYPE_NOT_ALLOWED: .* Migrations written as code \(Knex, TypeORM\) need SQL first/);
    expect(failed({ migrations: 'mig', setup: 'seed.ts' })).toBe('FILE_TYPE_NOT_ALLOWED: "seed.ts" is not one of the file types this tool reads. Fix: Pass a file ending in .sql inside the project folder "' + rootOf(dir).name + '".');
    expect(failed({ migrations: 'mig', files: ['0001.sql', '0002.ts'] })).toBe('FILE_TYPE_NOT_ALLOWED: "0002.ts" in files is not a .sql file. Fix: Leave it out of files: only .sql migrations run.');
  });
});
