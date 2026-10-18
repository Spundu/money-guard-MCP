// A record's pointer is escaped once per file, not once per row (SPEC.md §2.6). Review round 16: a
// 256-character records_pointer escaped for each of a million rows held the server 17-19 s.
import { describe, expect, it, vi } from 'vitest';
import { check } from './support/ledger.js';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/echo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/echo.js')>();
  return { ...real, escapeUnsafe: (...args: Parameters<typeof real.escapeUnsafe>) => ((calls.n += 1), real.escapeUnsafe(...args)) };
});

describe('records_pointer in findings', () => {
  it('is escaped once for a file, whatever the number of rows, and shown as escaping it whole would', async () => {
    const { escapeUnsafe } = await vi.importActual<typeof import('../src/echo.js')>('../src/echo.js');
    const key = `k${'\\'.repeat(200)}\u{200b}`;
    const rows = Array.from({ length: 2000 }, (_, i) => ({ t: `T${i}`, a: 0 })); // a ZERO_LEG and TOO_FEW_LEGS each
    calls.n = 0;
    const r = check('.json', JSON.stringify({ [key]: rows }), { columns: { transaction_id: 't', amount: 'a' }, records_pointer: `/${key}` });
    expect(r.total_findings).toBe(4000);
    expect(calls.n).toBeLessThan(50);
    expect(r.findings[0]?.pointers).toEqual([escapeUnsafe(`/${key}/0`)]);
  });

  it('decodes a mapped pointer once, not for every record', () => {
    // Review round 17: four pointers of 200 tokens each were split and decoded per record, ten times
    // slower than plain names on a million records. Compared with plain names, so no clock decides alone.
    const content = JSON.stringify(Array.from({ length: 200_000 }, (_, i) => ({ t: `T${i >> 1}`, a: i % 2 === 0 ? 1 : -1 })));
    const time = (columns: { transaction_id: string; amount: string }) => {
      const started = performance.now();
      check('.json', content, { columns });
      return performance.now() - started;
    };
    const deep = `${'/'.repeat(199)}x`; // 200 tokens, all but the first leading nowhere
    time({ transaction_id: 't', amount: 'a' }); // warm up
    const plain = time({ transaction_id: 't', amount: 'a' });
    const started = performance.now();
    try { check('.json', content, { columns: { transaction_id: '/t', amount: deep } }); } catch { /* no record has the field */ }
    expect((performance.now() - started) / plain).toBeLessThan(3);
  });
});
