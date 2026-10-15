// Which column names count as money (src/lint/names.ts, SPEC.md §3.5), against a table of real column
// names, and which names say the amounts are minor units already.
import { describe, expect, it } from 'vitest';
import { looksLikeMoney, namesMinorUnits, unitOfName, words } from '../src/lint/names.js';

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
  // Review round 5: a folded word inside a longer name; pay; what a holding is worth; more finance words;
  // a number at the end.
  'totalamount_old', 'unitprice_new', 'grossamount_2', 'totalamount2', 'platformfee_old', 'amountdue_original',
  'base_pay', 'holiday_pay', 'sick_pay', 'overtime_pay', 'take_home_pay', 'basepay', 'market_value', 'book_value',
  'fair_value', 'face_value', 'par_value', 'line_value', 'cashback', 'copay', 'reimbursement', 'installment',
  'instalment', 'dividends', 'royalty', 'arrears', 'overdraft_limit', 'payable', 'spending_limit', 'price2',
  // Review round 6: contributions, proceeds, UK retail, cash and sales metrics.
  'pension_contribution', 'employer_contribution', 'proceeds', 'sale_proceeds', 'postage', 'rrp', 'cash', 'cash_on_hand',
  'petty_cash', 'gmv', 'aov', 'arpu', 'notional', 'emi',
  // Review round 7: a generic money word followed by what the money is; balances, duties and other
  // charges; night rates; units finer than pence and currencies without them.
  'total_paid', 'total_spent', 'total_owing', 'net_worth', 'total_jpy', 'total_inc_vat', 'interest_earned', 'interest_accrued',
  'principal_outstanding', 'credit_limit_gbp', 'totals', 'bal', 'opening_bal', 'cur_bal', 'night_rate', 'deduction',
  'deductions', 'markup', 'gratuity', 'stamp_duty', 'customs_duty', 'excise', 'tariff', 'brokerage', 'amount_msat',
  'fee_msat', 'cost_micros', 'amount_jpy',
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
  // Review round 5: splits and sessions; sizes and counts of rows, pages and bytes; the last digits of a
  // card; a precision; when and how often pay comes.
  'revenue_split', 'commission_split', 'fee_split', 'payment_sessions', 'total_bytes', 'total_pages', 'totalhits',
  'totalrows', 'credit_card_last4', 'amount_precision', 'pay_frequency', 'pay_period', 'pay_date', 'pay_grade',
  // Review round 6: a folded percent split in the fewest pieces (per + cent would make it pence).
  'discountpercent', 'feepercent', 'taxpercent', 'chargepercent',
  // Review round 7: measures that start with a generic money word (total, net, credit, principal, interest).
  'total_co2', 'total_reps', 'total_carbs', 'total_latency', 'total_memory', 'total_tokens', 'total_errors', 'total_emissions',
  'total_rainfall', 'net_change', 'net_flow', 'credit_utilization', 'principal_component_1', 'interest_coverage',
];

describe('looksLikeMoney', () => {
  it.each(MONEY)('says %s is money', (name) => {
    expect(looksLikeMoney(name)).toBe(true);
  });

  it.each(NOT_MONEY)('says %s is not money', (name) => {
    expect(looksLikeMoney(name)).toBe(false);
  });

  it('has the table of about 350 names that SPEC.md §3.5 promises', () => {
    expect(MONEY.length + NOT_MONEY.length).toBeGreaterThanOrEqual(350);
  });
});

describe('namesMinorUnits', () => {
  it('spots names that already hold minor units', () => {
    const yes = ['amount_pence', 'price_cents', 'fee_penny', 'pence_total', 'amount_minor_units', 'price_cents_usd', 'totalpence', 'pricecents', 'amount_pennies', 'amount_paise',
      'amount_kobo', 'amount_paisa', 'amount_sats', 'amount_satoshis', 'amount_centavos', 'amount_kopecks', 'amount_wei', 'totalpennies', 'amountinpaise', 'amount_in_smallest_unit',
      'amount_in_smallest_units',
      // Review round 5: folded, inside a longer name or not.
      'amountminorunits', 'pricecentsusd', 'amountinsmallestunit', 'totalcentsdue', 'amountwei', 'centsamount'];
    expect(yes.map(namesMinorUnits)).toEqual(yes.map(() => true));
    const no = ['total', 'price', 'amount_gbp', 'totalamount', 'percent'];
    expect(no.map(namesMinorUnits)).toEqual(no.map(() => false));
  });

  it('is unsure of "minor" and "sat" without "unit" after them: they may name the unit, or a child\'s price or Saturday\'s', () => {
    // Review round 6: price_sat and price_minor would have been rounded as pence, losing a factor of 100.
    const unsure = ['price_sat', 'price_minor', 'fare_minor', 'pricesat', 'feesat', 'priceminor', 'amount_minor', 'amountMinor', 'amountminor', 'totalMinor', 'amountsat'];
    expect(unsure.map(unitOfName)).toEqual(unsure.map(() => 'unsure'));
    expect(['amount_minor_units', 'amount_sats', 'total', 'price_mon'].map(unitOfName)).toEqual(['minor', 'minor', 'major', 'major']);
  });

  it('is unsure of units finer than a minor unit, and rounds currencies that have no minor unit', () => {
    // Review round 7: cost_micros (Google Ads millionths) and amount_jpy (whole yen) were multiplied by 100.
    const unsure = ['cost_micros', 'amount_micros', 'budget_amount_micros', 'price_gwei', 'amount_millicents', 'price_mills'];
    expect(unsure.map(unitOfName)).toEqual(unsure.map(() => 'unsure'));
    const minor = ['amount_jpy', 'total_krw', 'price_vnd', 'amount_msat', 'fee_msats'];
    expect(minor.map(unitOfName)).toEqual(minor.map(() => 'minor'));
  });
});
