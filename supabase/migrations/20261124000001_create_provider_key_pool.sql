-- BLEA AI — pool API key multi-akun (khususnya Alibaba Cloud Model Studio)
--
-- Admin Panel → Alibaba Cloud mengelola banyak akun: saat generasi memakai
-- provider alibaba dan akun pertama terkena kuota/rate limit atau keynya
-- ditolak (401/402/403/429 atau kode kuota), worker otomatis mencoba akun
-- berikutnya sesuai prioritas. Akun gagal diberi cooldown sementara.
-- Kunci tetap sensitif: RLS admin-only, pola sama dengan provider_api_keys.

create table if not exists public.provider_key_pool (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'alibaba' check (char_length(provider) between 1 and 40),
  label text not null default '' check (char_length(label) <= 80),
  api_key text not null check (char_length(api_key) between 8 and 2048),
  base_url text not null default '',
  enabled boolean not null default true,
  priority integer not null default 100 check (priority between 0 and 10000),
  consecutive_failures integer not null default 0,
  cooldown_until timestamptz,
  last_error text,
  last_used_at timestamptz,
  last_success_at timestamptz,
  min_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.provider_key_pool is
  'Multi-account API key pool for provider failover (admin only, RLS enforced). Alibaba Cloud first.';

create index if not exists provider_key_pool_lookup_idx
  on public.provider_key_pool (provider, enabled, priority, created_at);

drop trigger if exists provider_key_pool_set_updated_at on public.provider_key_pool;
create trigger provider_key_pool_set_updated_at
  before update on public.provider_key_pool
  for each row execute function public.set_projects_updated_at();

alter table public.provider_key_pool enable row level security;
revoke all on table public.provider_key_pool from anon, authenticated;
grant select, insert, update, delete on table public.provider_key_pool to authenticated;

create policy provider_key_pool_admin_select on public.provider_key_pool
  for select to authenticated using (is_admin());
create policy provider_key_pool_admin_insert on public.provider_key_pool
  for insert to authenticated with check (is_admin());
create policy provider_key_pool_admin_update on public.provider_key_pool
  for update to authenticated using (is_admin()) with check (is_admin());
create policy provider_key_pool_admin_delete on public.provider_key_pool
  for delete to authenticated using (is_admin());

-- Menandai generasi video yang submit-nya memakai akun pool tertentu, supaya
-- polling status tetap ke workspace yang sama.
alter table public.video_generations add column if not exists provider_key_id uuid;
