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
