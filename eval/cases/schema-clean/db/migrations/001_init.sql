create table orders (
  id bigserial primary key,
  subtotal_pence bigint not null,
  tax_rate numeric(5,4) not null,
  total_pence bigint not null
);
