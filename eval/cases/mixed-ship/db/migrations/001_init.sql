create table customers (id bigserial primary key, name text not null);
create table invoices (
  id bigserial primary key,
  customer_id bigint references customers(id),
  total float8 not null,
  vat_rate numeric(5,4) not null,
  amount_paid_pence bigint not null default 0
);
