-- BLEA AI — tautan OAuth OpenAI (TANPA API key).
--
-- Kenapa ada tabel ini padahal sudah ada openai_accounts:
--   openai_accounts = kredensial yang SIAP dipakai pool (API key / token yang
--   sudah lolos uji). Tabel ini menyimpan jejak OAuth: state & PKCE yang sedang
--   menunggu callback, client_id terbitan OpenAI per akun (oaiapp_…), scope yang
--   disetujui, dan token tersegel untuk refresh. Tanpa tabel ini, refresh token
--   tidak bisa diputar dan audit "akun mana yang menyetujui apa" hilang.
--
-- Semua kolom token disegel AES-GCM dengan PROVIDER_CREDENTIAL_ENCRYPTION_KEY
-- dan tidak pernah dikirim ke browser. RLS: hanya pemilik baris (select) dan
-- admin (select/delete). Tidak ada insert/update dari klien — Worker memakai
-- service_role setelah memeriksa JWT pengguna.

create table if not exists public.openai_oauth_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- pending  → menunggu callback
  -- linked   → izin paket akun disetujui (scope chatgpt.tokens.use.direct)
  -- linked_identity_only → login berhasil tapi izin pemakaian paket tidak dicentang
  -- denied / failed → pengguna menolak / pertukaran kode gagal
  status text not null default 'pending' check (status in ('pending', 'linked', 'linked_identity_only', 'denied', 'failed')),
  state text not null default '' check (char_length(state) <= 200),
  nonce text not null default '' check (char_length(nonce) <= 200),
  code_verifier text not null default '' check (char_length(code_verifier) <= 200),
  redirect_uri text not null default '' check (char_length(redirect_uri) <= 300),
  requested_client_id text,
  issued_client_id text check (char_length(issued_client_id) <= 120),
  account_email text not null default '' check (char_length(account_email) <= 320),
  subject text not null default '' check (char_length(subject) <= 200),
  scopes text[] not null default '{}'::text[],
  plan_usage boolean not null default false,
  sealed_access_token text,
  sealed_refresh_token text,
  sealed_id_token text,
  access_expires_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.openai_oauth_links is
  'OAuth OpenAI (PKCE) links: pending attempts, issued client_ids, sealed tokens. service_role only for writes.';

create index if not exists openai_oauth_links_user_idx
  on public.openai_oauth_links (user_id, created_at desc);

drop trigger if exists openai_oauth_links_set_updated_at on public.openai_oauth_links;
create trigger openai_oauth_links_set_updated_at
  before update on public.openai_oauth_links
  for each row execute function public.set_projects_updated_at();

alter table public.openai_oauth_links enable row level security;
revoke all on table public.openai_oauth_links from anon, authenticated;
grant select on table public.openai_oauth_links to authenticated;

drop policy if exists openai_oauth_links_select_own on public.openai_oauth_links;
create policy openai_oauth_links_select_own on public.openai_oauth_links
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists openai_oauth_links_admin_select on public.openai_oauth_links;
create policy openai_oauth_links_admin_select on public.openai_oauth_links
  for select to authenticated using (public.is_admin());
