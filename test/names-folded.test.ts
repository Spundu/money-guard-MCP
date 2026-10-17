// The column-name rule (SPEC.md §3.5) on the names review round 20 found it read wrongly, and the folded form of
// every snake_case example SPEC gives, which must get the same answer (a word the rule does not know aside).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { amountInCurrency, looksLikeMoney, moneyByGuess, pricesAUnit, unitOfName } from '../src/lint/names.js';

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
      .toEqual(['guess', 'money', 'not', 'not', 'not', 'not']); // round 23: a held word further back is a guess
  });

  it('reads per diem as a daily allowance, and bals as balances', () => {
    expect(['per_diem_rate', 'per_diem_amount', 'per_diem_allowance', 'perdiem', 'account_bals', 'avail_bals'].map(verdict)).toEqual(['money', 'money', 'money', 'money', 'money', 'money']);
    expect(['per_diem_amount', 'per_diem_allowance'].map(pricesAUnit)).toEqual([false, false]);
  });
});

describe('the name rule, review round 21', () => {
  it('reads time off as leave, in hours', () => {
    expect(['time_off_balance', 'paid_time_off_balance', 'time_off_allowance', 'timeoffbalance', 'payoffbalance', 'time_balance'].map(verdict)).toEqual(['not', 'not', 'not', 'not', 'money', 'guess']);
  });

  it('reads a measure price with any currency code after it, and a number before the unit', () => {
    const names = ['price_kwh_aud', 'price_kwh_cad', 'cost_kwh_inr', 'price_litre_nzd', 'cost_gb_chf', 'price_100g', 'price_100ml', 'price_100g_pence'];
    expect(names.map((n) => [verdict(n), pricesAUnit(n)])).toEqual(names.map(() => ['money', true]));
  });

  it('takes a price per share for money, and more rates for prices', () => {
    expect(['price_per_share', 'dividend_per_share', 'nav_per_share', 'book_value_per_share', 'fee_per_share_bps', 'revenue_share'].map(verdict)).toEqual(['money', 'money', 'money', 'money', 'not', 'not']);
    expect(['hour_rate', 'costing_rate', 'valuation_rate', 'incoming_rate', 'cost_rate', 'unit_rate', 'rate_per_kwh', 'tax_rate', 'exchange_rate'].map(verdict))
      .toEqual(['money', 'money', 'money', 'money', 'money', 'money', 'money', 'not', 'not']);
  });

  it('holds the forms review round 21 found untested', () => {
    expect(['debit_in_account_ccy', 'debit_in_account_currency', 'cash_flows_total', 'cashflows_total'].map(verdict)).toEqual(['money', 'money', 'money', 'money']);
    expect(['per_kwh_price', 'per_unit_cost'].map(pricesAUnit)).toEqual([true, true]); // "per" first
  });

  it('leaves the unit of a folded scale to be decided', () => {
    expect(['amountx100', 'pricex1000', 'salaryk', 'amountk', 'bank', 'tax_100'].map(unitOfName)).toEqual(['unsure', 'unsure', 'unsure', 'unsure', 'major', 'major']);
  });
});

describe('the name rule, review round 22', () => {
  it('looks past state words for what a balance holds', () => {
    const hours = ['leave_remaining_balance', 'pto_available_balance', 'vacation_accrued_balance', 'time_off_remaining_balance', 'leaveremainingbalance', 'lieu_balance', 'time_in_lieu_balance', 'comptime_balance', 'flextime_balance'];
    expect(hours.map(verdict)).toEqual(hours.map(() => 'not'));
    expect(['flex_balance', 'outstanding_balance', 'available_balance', 'opening_balance', 'current_balance', 'account_available_balance'].map(verdict)).toEqual(['guess', 'money', 'money', 'money', 'money', 'money']);
  });

  it('reads a measure before the price, a pay rate before per, and the number of a tier', () => {
    expect(['kwh_price', 'litre_price', 'kg_cost'].map((n) => [verdict(n), pricesAUnit(n)])).toEqual([['money', true], ['money', true], ['money', true]]);
    expect(['room_rate_per_night', 'labour_rate_per_hour', 'pay_rate_per_hour', 'mileage_rate_per_mile', 'billable_rate', 'peak_rate', 'off_peak_rate', 'standard_rate', 'export_rate', 'price_tier_1', 'price_level_2', 'tax_rate_per_year'].map(verdict))
      .toEqual(['money', 'money', 'money', 'money', 'money', 'money', 'money', 'not', 'not', 'money', 'money', 'not']); // round 23: standard_rate is VAT's
    expect(['price_kg_qty', 'cost_kg_pct', 'price_kg_bps', 'nav_order', 'navorder', 'nav_per_share'].map(verdict)).toEqual(['not', 'not', 'not', 'not', 'not', 'money']);
    // A word before price or cost, and the measure last (found by mutation).
    expect(['standard_price_kwh', 'avg_cost_kg', 'base_price_kwh', 'price_kwh_pct', 'price_kwh_bps'].map((n) => [verdict(n), pricesAUnit(n)])).toEqual([['money', true], ['money', true], ['money', true], ['not', false], ['not', false]]);
  });

  it('leaves the unit of more scales to be decided', () => {
    const scaled = ['revenue_m', 'ebitda_m', 'revenue_mn', 'revenue_mio', 'revenue_000', 'revenue_gbp_000', 'revenue_lacs', 'revenue_crores'];
    expect(scaled.map(unitOfName)).toEqual(scaled.map(() => 'unsure'));
    expect(['revenue_100', 'amount_0001'].map(unitOfName)).toEqual(['major', 'major']);
  });
});

describe('the name rule, review round 23', () => {
  it('takes a held word further back for a guess, so no x100 either way', () => {
    const names = ['pto_carryover_balance', 'leave_entitlement_balance', 'vacation_carry_over_balance', 'overtime_bank_balance', 'pto_accrual_balance', 'leave_travel_allowance'];
    expect(names.map(verdict)).toEqual(names.map(() => 'guess'));
  });

  it('reads VAT and duty rates as rates, nav as money but navigation as not, and m after a number as months', () => {
    expect(['standard_rate', 'vat_standard_rate', 'import_rate', 'export_rate', 'nav', 'fund_nav', 'daily_nav', 'nav_order', 'nav_index', 'navorder'].map(verdict))
      .toEqual(['not', 'not', 'not', 'not', 'money', 'money', 'money', 'not', 'not', 'not']);
    expect(['revenue_12m', 'arr_3m', 'revenue_m', 'cr_amount', 'amount_cr', 'revenuem', 'salarym'].map(unitOfName)).toEqual(['major', 'major', 'unsure', 'major', 'major', 'unsure', 'unsure']);
    expect(['price_list_rate', 'outgoing_rate', 'pension', 'commission_tier_1', 'discount_level_2', 'price_tier_1', 'fee_band_3'].map(verdict)).toEqual(['money', 'money', 'money', 'guess', 'guess', 'money', 'money']);
    expect(['amount_residual_currency', 'amount_currency', 'payment_method_currency'].map(amountInCurrency)).toEqual([true, true, false]);
  });
});

describe('folded names', () => {
  it('get the answer their snake_case form gets, for every example in SPEC.md §3.5', () => {
    const spec = readFileSync(path.resolve(import.meta.dirname, '..', 'SPEC.md'), 'utf8');
    const section = spec.slice(spec.indexOf('### 3.5'), spec.indexOf('### 3.6'));
    const names = [...new Set([...section.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1] ?? ''))];
    expect(names.length).toBeGreaterThan(100);
    // A word the rule does not know (ytd, used, updated, aud, click) cannot be split off, and "percent" is one word, not per + cent.
    const unknown = ['money_columns', 'net_ytd', 'credit_used', 'price_per_cent', 'price_updated_at', 'price_kwh_aud', 'cost_per_click_micros', 'leave_travel_allowance', 'pto_carryover_balance'];
    expect(names.filter((n) => !unknown.includes(n) && verdict(n) !== verdict(n.replaceAll('_', '')))).toEqual([]);
    // Round 21: the unit and the unit price too.
    const answer = (n: string) => `${unitOfName(n)} ${pricesAUnit(n)}`;
    expect(names.filter((n) => !unknown.includes(n) && looksLikeMoney(n) && answer(n) !== answer(n.replaceAll('_', '')))).toEqual([]);
  });
});

describe('the name rule, review round 24', () => {
  it('takes a tier, level or band number without a money word for no money', () => {
    const names = ['water_level_1', 'zoom_level_2', 'battery_level_1', 'level_1', 'tier_2', 'band_3', 'confidence_level_95', 'risk_level_3', 'level1'];
    expect(names.map(verdict)).toEqual(names.map(() => 'not'));
    expect(['price_tier_1', 'commission_tier_1', 'fee_band_3'].map(verdict)).toEqual(['money', 'guess', 'money']);
  });

  it('takes a budget of a count or a measure for no money, as a total of one', () => {
    const names = ['kwh_budget', 'qty_budget', 'power_budget', 'weight_budget', 'fte_budget', 'headcount_budget', 'seats_budget', 'bytes_budget', 'percent_budget'];
    expect(names.map(verdict)).toEqual(names.map(() => 'not'));
    expect(['marketing_budget', 'growth_budget', 'units_budget', 'holiday_budget'].map(verdict)).toEqual(['money', 'money', 'money', 'money']);
  });

  it('takes a folded held word first, before words it cannot read, for a guess', () => {
    const names = ['ptocarryoverbalance', 'overtimebankbalance', 'leavecarryoverbalance', 'leavetravelallowance'];
    expect(names.map(verdict)).toEqual(names.map(() => 'guess'));
    expect(['leavebalance', 'accountbalance', 'travelallowance'].map(verdict)).toEqual(['not', 'money', 'money']);
  });

  it('takes nav before a word that is not money for navigation', () => {
    expect(['nav_lat', 'nav_lon', 'nav_heading', 'nav_x', 'nav_visible', 'nav_order', 'navorder'].map(verdict)).toEqual(['not', 'not', 'not', 'not', 'not', 'not', 'not']);
    expect(['nav', 'nav_per_share', 'nav_usd', 'nav_value', 'nav_amount', 'fund_nav'].map(verdict)).toEqual(['money', 'money', 'money', 'money', 'money', 'money']);
  });

  it('takes a unit of measure after a money word for no money, and a bare percentage word for a guess', () => {
    const units = ['amount_grams', 'amount_litres', 'amount_hrs', 'amount_tons', 'amount_meters', 'amount_mins', 'amount_mb', 'amount_gb', 'amount_kw', 'amount_watts', 'deposit_litres', 'amountgrams'];
    expect(units.map(verdict)).toEqual(units.map(() => 'not'));
    expect(['cost_gb', 'price_mb', 'amount_gbp'].map(verdict)).toEqual(['money', 'money', 'money']);
    expect(['discount', 'discounts', 'markup', 'commission', 'ltv', 'discount_amount', 'commission_paid'].map(verdict)).toEqual(['guess', 'guess', 'guess', 'guess', 'guess', 'money', 'money']);
  });
});
