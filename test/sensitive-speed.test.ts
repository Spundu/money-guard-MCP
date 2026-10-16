// The secret-file screen (src/paths.ts isSensitive, SPEC.md §2.3): names paths.test.ts has no room for, and
// it reads any name in time that grows with its length. Review round 17: "logins1-1-1-…-x.csv" made its
// regex backtrack, ×3 for each "1-": a 56-character name, which a repository can ship as an empty file,
// held the server for hours.
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.js';
import { isSensitive, resolveInRoot } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

describe('isSensitive on the files command-line tools keep logins in', () => {
  it('refuses ledger-type files in their folders, and token files by name', () => {
    // Review round 18: these were read as ledgers.
    for (const p of ['.config/gcloud/legacy_credentials/me/adc.json', '.azure/msal_token_cache.json', '.azure/service_principal_entries.json', '.config/configstore/firebase-tools.json',
      '.aws/cli/cache/x.json', 'gmail-token.json', 'token_cache.json', 'vault-token.json', 'mycreds.json',
      // Review round 19 (found by mutation): the other forms of each rule.
      'tokencache.json', 'token-cache-backup.json', 'mycred.json', 'gmail.token.json']) {
      expect(isSensitive(p), p).toBe(true);
    }
    for (const p of ['exports/ledger.json', 'azure_costs.csv', 'tokens_used.csv', 'kube_billing.csv', '.aws/notes.txt']) expect(isSensitive(p), p).toBe(false);
  });

  it('names the folder when it is the reason, and the way out', () => {
    // Review round 19: a billing export saved in gcloud/ was "a secrets file", and told to pass what it was.
    const dir = tempDir();
    writeTree(dir, { 'gcloud/billing_export.csv': 'id,amount\n' });
    let text = '';
    try {
      resolveInRoot(rootOf(dir), 'gcloud/billing_export.csv', { kind: 'file', extensions: ['.csv'] });
    } catch (err) {
      text = err instanceof ToolError ? err.toText() : String(err);
    }
    expect(text).toBe('SENSITIVE_PATH: "gcloud/billing_export.csv" is inside "gcloud", a folder where command-line tools keep their logins. Fix: money-guard reads no ledger-type file there. Copy the export to another folder of the project, then pass that path.');
  });
});

describe('isSensitive on names that almost match', () => {
  it('answers a near miss of 30 dashes and digits at once', () => {
    for (const name of [`logins${'1-'.repeat(30)}x.csv`, `keystore${'-1'.repeat(30)}x.json`, `logins${' _-'.repeat(30)}x.csv`]) {
      const started = performance.now();
      expect(isSensitive(name), name).toBe(false);
      expect(performance.now() - started, name).toBeLessThan(200);
    }
    // The forms it is for still match.
    // Review round 18: the separators and copies the linear form must still allow.
    for (const name of ['logins-2026-10-16.csv', 'logins_backup.json', 'logins (1).csv', 'keystore-2.json', 'logins_export.csv', 'logins-export.json', 'keystore_export.json', 'logins copy.csv', 'logins-1 (2).csv']) {
      expect(isSensitive(name), name).toBe(true);
    }
  });
});
