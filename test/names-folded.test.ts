// The column-name rule (SPEC.md §3.5) on the names review round 20 found it read wrongly, and the folded form of
// every snake_case example SPEC gives, which must get the same answer (a word the rule does not know aside).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikeMoney, moneyByGuess, pricesAUnit, unitOfName } from '../src/lint/names.js';

const verdict = (name: string) => (moneyByGuess(name) ? 'guess' : looksLikeMoney(name) ? 'money' : 'not');

describe('the name rule, review round 20', () => {
  it('reads a measure price with a unit or a currency after or before the measure', () => {
    const names = ['price_kwh_pence', 'cost_kwh_gbp', 'price_kg_cents', 'price_pence_kwh', 'price_kg'];
    expect(names.map((n) => [verdict(n), pricesAUnit(n)])).toEqual(names.map(() => ['money', true]));
  });

  it('splits folded names by every word the rules read', () => {
    expect(['flexibalance', 'toilbalance', 'cashflowtotal', 'allowancedaysleft', 'realtimebalance', 'pricepointsbalance'].map(verdict)).toEqual(['not', 'not', 'money', 'not', 'guess', 'not']);
    expect(['costpergb', 'pricepergb', 'pricegb', 'pricelitre', 'priceperlitre'].map(pricesAUnit)).toEqual([true, true, true, true, true]);
  });

  it('takes a price per hour or day for a unit price, and one per seat or user for an ordinary price', () => {
    expect(['price_per_hour', 'cost_per_hour', 'price_per_day', 'rate_per_hour', 'price_per_seat', 'price_per_user', 'cost_per_employee', 'price_per_ticket', 'price_per_month'].map(pricesAUnit))
      .toEqual([true, true, true, true, false, false, false, false, false]);
  });

  it('takes cash flow for money', () => {
    expect(['cash_flow_total', 'cash_flow_balance', 'cash_flow_budget', 'operating_cash_flow_total', 'cashflow', 'water_flow_total', 'total_flow', 'net_flow'].map(verdict))
      .toEqual(['money', 'money', 'money', 'money', 'money', 'not', 'not', 'not']);
  });

  it('leaves the unit of a scale other than pounds to be decided', () => {
    const scaled = ['revenue_millions', 'revenue_in_thousands', 'amount_thousands', 'revenue_k', 'revenue_mm', 'amount_bn', 'amount_x100', 'amount_hundredths', 'revenuemillions', 'amount_lakhs'];
    expect(scaled.map(unitOfName)).toEqual(scaled.map(() => 'unsure'));
    expect(['amount', 'amount_x', 'amount_100', 'price_per_thousand'].map(unitOfName)).toEqual(['major', 'major', 'major', 'major']);
  });

  it('reads what a balance or an allowance holds from the word right before it', () => {
    expect(['leave_travel_allowance', 'travelallowance', 'leave_balance', 'annual_leave_balance', 'pto_days_budget', 'sick_leave_hours_balance'].map(verdict))
      .toEqual(['money', 'money', 'not', 'not', 'not', 'not']);
  });

  it('reads per diem as a daily allowance, and bals as balances', () => {
    expect(['per_diem_rate', 'per_diem_amount', 'per_diem_allowance', 'perdiem', 'account_bals', 'avail_bals'].map(verdict)).toEqual(['money', 'money', 'money', 'money', 'money', 'money']);
    expect(['per_diem_amount', 'per_diem_allowance'].map(pricesAUnit)).toEqual([false, false]);
  });
});

describe('folded names', () => {
  it('get the answer their snake_case form gets, for every example in SPEC.md §3.5', () => {
    const spec = readFileSync(path.resolve(import.meta.dirname, '..', 'SPEC.md'), 'utf8');
    const section = spec.slice(spec.indexOf('### 3.5'), spec.indexOf('### 3.6'));
    const names = [...new Set([...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1] ?? ''))];
    expect(names.length).toBeGreaterThan(100);
    // A word the rule does not know (ytd, used, updated) cannot be split off, and "percent" is one word, not per + cent.
    const unknown = ['money_columns', 'net_ytd', 'credit_used', 'price_per_cent', 'price_updated_at'];
    expect(names.filter((n) => !unknown.includes(n) && verdict(n) !== verdict(n.replaceAll('_', '')))).toEqual([]);
  });
});
