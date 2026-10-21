create table products (
  id serial primary key,
  name text not null,
  price money not null,
  weight_kg real
);
