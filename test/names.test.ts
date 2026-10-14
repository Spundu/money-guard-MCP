import { describe, expect, it } from 'vitest';
import { looksLikeMoney, namesMinorUnits, words } from '../src/lint/names.js';

describe('words', () => {
  it('splits snake_case, kebab-case, camelCase, acronyms and digits', () => {
    expect(words('amount_pence')).toEqual(['amount', 'pence']);
    expect(words('amountMinor')).toEqual(['amount', 'minor']);
    expect(words('GBPAmount')).toEqual(['gbp', 'amount']);
    expect(words('unitPriceGBP')).toEqual(['unit', 'price', 'gbp']);
    expect(words('price2')).toEqual(['price', '2']);
    expect(words('fee-total')).toEqual(['fee', 'total']);
    expect(words('Total')).toEqual(['total']);
  });
});

// Real column names: Stripe's API fields, Shopify's, Supabase templates, and ledgers like
// integer-pence-ledger. Each line says what the rule must answer.
const MONEY = [
  'amount', 'amount_pence', 'amountMinor', 'amount_minor', 'amount_due', 'amount_paid', 'amount_refunded',
  'amount_captured', 'amount_received', 'amount_capturable', 'amount_subtotal', 'amount_total',
  'amount_remaining', 'application_fee_amount', 'unit_amount', 'unit_price', 'price', 'price_per_unit',
  'total', 'subtotal', 'total_price', 'total_gbp', 'totalPrice', 'grand_total', 'total_tax', 'tax',
  'vat', 'discount', 'shipping_cost', 'cost', 'fee', 'platform_fee', 'fee_pence', 'balance',
  'balance_after', 'account_balance', 'refund', 'payout', 'salary', 'revenue', 'price_cents',
  'priceInCents', 'compare_at_price', 'deposit_amount', 'charge', 'surcharge', 'money', 'net_amount',
  'gross_amount', 'amount_gbp', 'credit_amount', 'debit_amount', 'wage',
  // Per-unit prices: the words after "per" say what the amount is for (review round 1).
  'price_per_month', 'price_per_hour', 'cost_per_hour', 'fee_per_day', 'amount_per_month', 'cost_per_kg_weight',
  // Unquoted CamelCase that PostgreSQL folded to lowercase.
  'totalamount', 'unitprice', 'shippingcost', 'amountminor', 'grandtotal', 'totalpence',
  'minor_units', 'amount_minor_units', 'price_cents_usd',
];
const NOT_MONEY = [
  'id', 'stripe_price_id', 'price_id', 'amount_currency', 'currency', 'price_updated_at', 'total_count',
  'tax_rate', 'vat_rate', 'fee_bps', 'discount_percent', 'total_items', 'payment_method',
  'payment_status', 'payment_attempts', 'refund_reason', 'charge_id', 'tax_code', 'vat_number',
  'price_tier', 'fee_type', 'balance_updated_at', 'payout_date', 'total_weight',
  'total_distance', 'discount_code', 'tax_year', 'payment_terms_days', 'salary_band', 'price_version',
  'created_at', 'name', 'email', 'quantity', 'percent', 'accent_color', 'taxonomy_id', 'discharge_date',
  'coffee_type', 'europe_region', 'percentage',
  'tax_rate_per_year', 'count_per_day', 'minor', 'minor_version', 'total_kwh', 'total_volume', 'total_points',
  'total_votes', 'costcenter', 'pricelist', 'totalcount', 'paymentmethod', 'coffee', 'syntax', 'discharge',
];

describe('looksLikeMoney', () => {
  it.each(MONEY)('says %s is money', (name) => {
    expect(looksLikeMoney(name)).toBe(true);
  });

  it.each(NOT_MONEY)('says %s is not money', (name) => {
    expect(looksLikeMoney(name)).toBe(false);
  });

  it('has a table of at least 80 real names (SPEC.md §3.5)', () => {
    expect(MONEY.length + NOT_MONEY.length).toBeGreaterThanOrEqual(80);
  });
});

describe('namesMinorUnits', () => {
  it('spots names that already hold minor units', () => {
    const yes = ['amount_pence', 'amountMinor', 'price_cents', 'fee_penny', 'pence_total', 'amount_minor_units', 'price_cents_usd', 'amountminor', 'totalpence'];
    expect(yes.map(namesMinorUnits)).toEqual(yes.map(() => true));
    const no = ['total', 'price', 'amount_gbp', 'totalamount', 'percent'];
    expect(no.map(namesMinorUnits)).toEqual(no.map(() => false));
  });
});
