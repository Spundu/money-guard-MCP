// Which column names count as money (src/lint/names.ts, SPEC.md §3.5), against a table of real column
// names, and which names say the amounts are minor units already.
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
  'totalamount', 'unitprice', 'shippingcost', 'amountminor', 'grandtotal', 'totalpence', 'pricecents', 'amountcents',
  // ... or that starts with a long money word (review round 2): Stripe's amount_due, total_tax and
  // balance_after, written in CamelCase without quotes.
  'amountdue', 'totaltax', 'balanceafter', 'amountpaid',
  'amount_minor_units', 'price_cents_usd',
  // Ledger and finance words (review round 2).
  'debit', 'credit', 'net', 'gross', 'commission', 'deposit', 'interest', 'principal', 'expense', 'income',
  'profit', 'earnings', 'budget', 'credit_limit', 'msrp', 'mrr', 'amount_pennies', 'amount_paise',
  // Pay, commerce and insurance (review round 3): pay rates are money, other rates are not.
  'hourly_rate', 'pay_rate', 'day_rate', 'bill_rate', 'bonus', 'allowance', 'stipend', 'per_diem', 'shipping', 'tip',
  'rent', 'fare', 'ad_spend', 'premium', 'deductible', 'donation', 'penalty', 'pnl', 'cogs', 'totalpennies',
  'amountinpaise', 'amount_sats', 'amount_kobo',
  // Review round 4: folded names split into known words; amounts "in" a currency; priced rates; what an
  // order is worth; Indian and Australian price and tax words.
  'platformfee', 'servicefee', 'latefee', 'salestax', 'hourlyrate', 'creditlimit', 'totaldiscount', 'linetotal',
  'openingbalance', 'debit_in_account_currency', 'amount_in_company_currency', 'room_rate', 'overtime_rate',
  'mileage_rate', 'rate_per_hour', 'mrp', 'gst', 'order_value', 'cart_value', 'amount_in_smallest_unit',
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
  // Review round 2: a version part, measures, ratios, groupings and terms.
  'version_minor', 'minor_patch', 'gross_margin', 'profit_margin', 'price_elasticity', 'total_miles', 'amount_ml',
  'cost_center', 'price_list', 'expense_category', 'payment_terms', 'budget_period', 'interest_rate',
  'commission_rate', 'credit_score', 'net_weight', 'principal_id', 'totaltime', 'pricetier',
  // Review round 3: measures, ratios after "per", version parts, Stripe ids and labels.
  'total_calories', 'total_energy', 'gross_weight_lbs', 'net_weight_lbs', 'total_rating', 'net_tonnage',
  'fee_per_txn_bps', 'commission_per_sale_pct', 'os_minor', 'app_minor', 'exchange_rate', 'shipping_address',
  'payment_intent', 'balance_transaction', 'fare_class',
  // Review round 4: folded names ending in a short non-money word; counts of nights, guests, users and
  // units; measures; shares; ISO 4217's minor unit (a currency's exponent); a rate per second; values
  // that are not money; look-alikes a folded split must not turn into money.
  'totalqty', 'totalkwh', 'totalkg', 'totalpct', 'paymentday', 'priceid', 'total_nights', 'total_guests',
  'total_area', 'revenue_share', 'minor_unit', 'minor_units', 'total_users', 'total_weeks', 'net_units', 'gross_area',
  'total_usage', 'total_power', 'rate_per_second', 'metric_value', 'setting_value', 'value', 'price_unit',
  'payment_method_currency', 'network', 'farewell', 'online', 'baseline', 'cashflow', 'creditscore', 'interestrate',
];

describe('looksLikeMoney', () => {
  it.each(MONEY)('says %s is money', (name) => {
    expect(looksLikeMoney(name)).toBe(true);
  });

  it.each(NOT_MONEY)('says %s is not money', (name) => {
    expect(looksLikeMoney(name)).toBe(false);
  });

  it('has the table of about 250 names that SPEC.md §3.5 promises', () => {
    expect(MONEY.length + NOT_MONEY.length).toBeGreaterThanOrEqual(250);
  });
});

describe('namesMinorUnits', () => {
  it('spots names that already hold minor units', () => {
    const yes = ['amount_pence', 'amountMinor', 'price_cents', 'fee_penny', 'pence_total', 'amount_minor_units', 'price_cents_usd', 'amountminor', 'totalpence', 'pricecents', 'amount_pennies', 'amount_paise',
      'amount_kobo', 'amount_paisa', 'amount_sats', 'amount_satoshis', 'amount_centavos', 'amount_kopecks', 'amount_wei', 'totalpennies', 'amountinpaise', 'amount_in_smallest_unit'];
    expect(yes.map(namesMinorUnits)).toEqual(yes.map(() => true));
    const no = ['total', 'price', 'amount_gbp', 'totalamount', 'percent'];
    expect(no.map(namesMinorUnits)).toEqual(no.map(() => false));
  });
});
