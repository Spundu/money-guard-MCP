create table wallets (id bigserial primary key, owner text not null, balance double precision not null default 0);
