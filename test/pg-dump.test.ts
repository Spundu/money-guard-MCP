// A pg_dump file sets the client encoding to its database's (SPEC.md §3.3). The file is read as UTF-8, and
// PGlite stops answering under most other encodings (WIN1252, the usual one on Windows), or hangs on a name that
// is not ASCII under LATIN1. Review round 22: a schema dump of a Windows database could not be linted.
import { describe, expect, it } from 'vitest';
import { prepareSql } from '../src/lint/files.js';
import { lint } from './support/lint.js';

/** The head of a pg_dump --schema-only file, as pg_dump 18 writes it. */
const header = (encoding: string) => `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = '${encoding}';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;

`;

describe('a pg_dump file', () => {
  it('blanks only a line that sets the client encoding, keeping its length', () => {
    for (const line of ["SET client_encoding = 'WIN1252';", "set client_encoding to 'LATIN9';", "SET NAMES 'SJIS';", "  SET SESSION client_encoding = 'LATIN1' ;"]) {
      expect(prepareSql(line), line).toBe(' '.repeat(line.length));
    }
    for (const line of ["SET client_encoding = 'WIN1252'; create table t (a int);", "SET standard_conforming_strings = on;", "-- SET client_encoding = 'WIN1252';"]) {
      expect(prepareSql(line), line).toBe(line);
    }
  });

  it('is linted whatever encoding its database had', async () => {
    for (const encoding of ['WIN1252', 'LATIN9', 'SJIS']) {
      const r = await lint({ 'db/migrations/0001.sql': `${header(encoding)}CREATE TABLE public.t (price double precision);\n` });
      expect(r.findings.map((f) => f.code), encoding).toEqual(['FLOAT_MONEY']);
    }
  });

  it('is read in time when its names and defaults are not ASCII', async () => {
    const started = performance.now();
    const r = await lint({ 'db/migrations/0001.sql': `${header('LATIN1')}CREATE TABLE public.café (prix_total double precision DEFAULT 0, note text DEFAULT 'crème');\n` }, { timeout_seconds: 30 });
    expect(r.findings.map((f) => f.column)).toEqual(['prix_total']);
    expect(performance.now() - started).toBeLessThan(25_000);
  });
});

describe('a pg_dump baseline among later migrations', () => {
  it('leaves the search path to the files after it', async () => {
    // Review round 23: its set_config line emptied the search path, and an unqualified name later was "does not exist".
    const r = await lint({ 'db/migrations/0000_baseline.sql': `${header('UTF8')}CREATE TABLE public.orders (id integer);\n`, 'db/migrations/0001_fee.sql': 'alter table orders add column fee double precision;' });
    expect(r.findings.map((f) => f.column)).toEqual(['fee']);
    for (const line of ["SET client_encoding = 'WIN1252'; -- from the dump", "SET LOCAL client_encoding = 'LATIN1';", "SELECT pg_catalog.set_config('search_path', '', false);"]) {
      expect(prepareSql(line), line).toBe(' '.repeat(line.length));
    }
    expect(prepareSql("SELECT pg_catalog.set_config('search_path', 'app', false);")).toBe("SELECT pg_catalog.set_config('search_path', 'app', false);"); // a migration's own choice stays
  });
});

describe('the markers of node-pg-migrate', () => {
  it('runs only what lies between the first up marker and the first down marker after it, as node-pg-migrate does', () => {
    // Review round 24: a header before the up marker, and a second up marker after the down part, ran too.
    const run = (sql: string) => prepareSql(sql).split('\n').filter((line) => line.trim() !== '');
    expect(run('create table header (x int);\n-- Up Migration\ncreate table a (x int);\n-- Down Migration\ndrop table a;\n-- Up Migration\ncreate table b (x int);\n'))
      .toEqual(['-- Up Migration', 'create table a (x int);']);
    expect(run('-- Down Migration\ndrop table b;\n-- Up Migration\ncreate table b (x int);\n')).toEqual(['-- Up Migration', 'create table b (x int);']);
    expect(run('-- migrate:up\ncreate table a (x int);\n-- migrate:down\ndrop table a;\n-- migrate:up\ncreate table b (x int);\n')).toEqual(['-- migrate:up', 'create table a (x int);', '-- migrate:up', 'create table b (x int);']); // dbmate as before
  });
});

describe('a client encoding set some other way', () => {
  it('is put back after each file, so a name that is not ASCII is read in time', async () => {
    // Review round 23: set_config('client_encoding', 'LATIN1') is no line to blank; the catalog read hung to the limit.
    const started = performance.now();
    const r = await lint({ 'db/migrations/0001.sql': "select pg_catalog.set_config('client_encoding', 'LATIN1', false);\ncreate table t (\"price_é\" double precision);\n" }, { timeout_seconds: 30 });
    expect(r.findings.map((f) => f.column)).toEqual(['price_é']);
    expect(performance.now() - started).toBeLessThan(25_000);
  });

  it('is not reported as PostgreSQL refusing a statement when PGlite itself fails under it', async () => {
    // Review round 24: a failing statement under LATIN1 gave PGlite's "r is not a function" as the database's refusal.
    const sql = "select pg_catalog.set_config('client_encoding', 'LATIN1', false);\ncreate table \"é\" (price float);\ncreate table \"é\" (x int);\n";
    const text = await lint({ 'db/migrations/0001.sql': sql }, { timeout_seconds: 30 }).then(() => '', (err: { toText(): string }) => err.toText());
    expect(text).toMatch(/^MIGRATION_FAILED: .*0001\.sql": after this file the database no longer answers correctly \(.*a change of client encoding\)\./);
    expect(text).not.toContain('is not a function');
  });
});
