-- BLEA AI — pool akun OAuth Freebeat multi-akun untuk round-robin failover
-- saat saldo kredit gateway akun Freebeat habis.
--
-- Token terenkripsi disimpan tersegel pada sealed_session dan HANYA diakses
-- server-side oleh Cloudflare Worker melalui service_role (tidak pernah
-- diekspos ke browser).

create table if not exists public.freebeat_oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  account_email text not null default '' check (char_length(account_email) <= 320),
  account_label text not null default '' check (char_length(account_label) <= 100),
  connected_by uuid references auth.users(id) on delete set null,
  sealed_session text not null check (char_length(sealed_session) between 10 and 4000),
  image_access boolean not null default false,
  enabled boolean not null default true,
  priority integer not null default 100 check (priority between 0 and 100000),
  last_balance_credits numeric,
  last_balance jsonb,
  last_balance_checked_at timestamptz,
  consecutive_failures integer not null default 0,
  last_error text,
  last_used_at timestamptz,
  last_success_at timestamptz,
  issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.freebeat_oauth_accounts is
  'Multi-account encrypted Freebeat OAuth token pool for round-robin balance failover (worker service_role only).';

create index if not exists freebeat_oauth_accounts_lookup_idx
  on public.freebeat_oauth_accounts (enabled, priority, created_at);

drop trigger if exists freebeat_oauth_accounts_set_updated_at on public.freebeat_oauth_accounts;
create trigger freebeat_oauth_accounts_set_updated_at
  before update on public.freebeat_oauth_accounts
  for each row execute function public.set_projects_updated_at();

alter table public.freebeat_oauth_accounts enable row level security;
revoke all on table public.freebeat_oauth_accounts from anon, authenticated;

-- Migrasi otomatis sesi tunggal yang sudah aktif agar langsung terdaftar
-- sebagai akun #1 di pool tanpa memutus layanan yang sedang berjalan.
insert into public.freebeat_oauth_accounts (
  account_email,
  account_label,
  connected_by,
  sealed_session,
  image_access,
  enabled,
  priority,
  issued_at,
  updated_at
)
select
  coalesce(nullif(trim(p.email), ''), 'Akun Freebeat Utama'),
  coalesce(nullif(trim(p.full_name), ''), 'Akun Utama'),
  fps.user_id,
  fps.sealed_session,
  fps.image_access,
  true,
  10,
  fps.issued_at,
  fps.updated_at
from public.freebeat_provider_sessions fps
left join public.profiles p on p.id = fps.user_id
where char_length(fps.sealed_session) between 10 and 4000
  and not exists (
    select 1
    from public.freebeat_oauth_accounts a
    where a.connected_by = fps.user_id
  );
