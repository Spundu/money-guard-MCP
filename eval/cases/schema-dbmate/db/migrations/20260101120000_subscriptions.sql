-- migrate:up
create table subscriptions (id bigserial primary key, plan text not null, monthly_price real not null);

-- migrate:down
drop table subscriptions;
