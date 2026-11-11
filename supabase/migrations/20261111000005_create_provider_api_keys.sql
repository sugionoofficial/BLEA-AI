-- BLEA AI — provider API key settings (admin panel "Connect API key")
--
-- Semua provider yang memakai API key (UnoRouter, nanti provider lain)
-- disimpan di sini. Kunci DISIMPAN SENDIRI sensitif — kebijakan RLS meminta
-- admin, dan penyimpanan mempertimbangkan encrypted_at (Postgres pgcrypto)
-- untuk perlindungan tambahan.
--
-- Kunci historis TIDAK di-update (per min_verified_at).

create extension if not exists pgcrypto with schema extensions;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select auth.jwt()->'app_metadata'->>'role' = 'admin'
$$;

-- ---------------------------------------------------------------- settings
create table if not exists public.provider_api_keys (
  provider text primary key check (char_length(provider) between 1 and 40),
  api_key text not null check (char_length(api_key) = 0 or char_length(api_key) between 8 and 2048),
  base_url text,
  label text not null default '' check (char_length(label) <= 80),
  encrypted_at timestamptz not null default now(),
  min_verified_at timestamptz,
  min_verified_version text,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.provider_api_keys is
  'API key provider settings configured from admin panel — admin only, RLS enforced.';

create trigger provider_api_keys_set_updated_at
  before update on public.provider_api_keys
  for each row execute function public.set_projects_updated_at();

-- RLS: SELAIN admin, NIHIL (supaya aplikasi tidak bisa membaca kunci melalui
-- fungsi client lain). Admin bisa baca/tulis semua.
alter table public.provider_api_keys enable row level security;
revoke all on table public.provider_api_keys from anon, authenticated;
grant select, insert, update, delete on table public.provider_api_keys to authenticated;

create policy provider_api_keys_admin_select on public.provider_api_keys
  for select to authenticated using (is_admin());
create policy provider_api_keys_admin_insert on public.provider_api_keys
  for insert to authenticated with check (is_admin());
create policy provider_api_keys_admin_update on public.provider_api_keys
  for update to authenticated using (is_admin()) with check (is_admin());
create policy provider_api_keys_admin_delete on public.provider_api_keys
  for delete to authenticated using (is_admin());

-- Menambah provider di masa depan hanya perlu row baru — tidak perlu migration.
insert into public.provider_api_keys (provider, api_key, label, min_verified_version)
select 'unorouter', '', 'UnoRouter — gateway model teks gratis', 'v1'
where not exists (select 1 from public.provider_api_keys where provider = 'unorouter');
