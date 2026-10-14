// The Supabase preset (SPEC.md §3.4): stand-ins for the objects every Supabase project already has, so
// ordinary migrations run in a plain PostgreSQL. That covers RLS policies TO authenticated,
// auth.uid(), grants, foreign keys to auth.users, storage buckets and policies, extensions in the
// extensions schema, and realtime publications. Columns created here are never checked.

export const SUPABASE_PRESET = `
-- Roles that policies and grants name.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator NOINHERIT LOGIN;
CREATE ROLE supabase_admin NOLOGIN;
CREATE ROLE supabase_auth_admin NOLOGIN;
CREATE ROLE supabase_storage_admin NOLOGIN;
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE SCHEMA extensions;

-- Supabase installs these two in the extensions schema and puts that schema on the search path.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
SET search_path = "$user", public, extensions;

CREATE TABLE auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  recovery_token varchar(255),
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false,
  is_anonymous boolean NOT NULL DEFAULT false
);

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.email', true), '')::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  user_metadata jsonb,
  path_tokens text[],
  version text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE
  AS $$ SELECT (pg_catalog.string_to_array(name, '/'))[1:pg_catalog.array_length(pg_catalog.string_to_array(name, '/'), 1) - 1] $$;
CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT (pg_catalog.string_to_array(name, '/'))[pg_catalog.array_length(pg_catalog.string_to_array(name, '/'), 1)] $$;
CREATE FUNCTION storage.extension(name text) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT pg_catalog.reverse(pg_catalog.split_part(pg_catalog.reverse(name), '.', 1)) $$;

CREATE PUBLICATION supabase_realtime;
`;
