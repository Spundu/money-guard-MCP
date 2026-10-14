create table orders (id bigserial primary key, total double precision not null, currency text not null default 'GBP');
