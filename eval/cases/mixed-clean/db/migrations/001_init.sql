create table orders (id bigserial primary key, total_pence bigint not null, discount_rate numeric(5,4) not null default 0);
