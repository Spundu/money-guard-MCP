create table refunds (id bigserial primary key, invoice_id bigint references invoices(id), refund_amount numeric, reason text);
