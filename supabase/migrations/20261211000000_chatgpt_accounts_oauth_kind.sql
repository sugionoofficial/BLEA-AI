-- Tambah jenis kredensial 'oauth' + kolom token OAuth pada pool akun ChatGPT.
--
-- Kenapa: permintaan "koneksikan seperti freebeat tanpa apikey". Lewat alur
-- resmi Sign in with ChatGPT, akun tidak punya API key — yang ada access token
-- (1 jam) + refresh token (30 hari bergulir) + client_id terbitan OpenAI.
-- Kolomnya ditambahkan lewat ALTER supaya tabel yang sudah berisi data tidak
-- perlu dibuat ulang.

alter table public.chatgpt_accounts
  drop constraint if exists chatgpt_accounts_credential_kind_check;

alter table public.chatgpt_accounts
  add constraint chatgpt_accounts_credential_kind_check
  check (credential_kind in ('api_key', 'session', 'oauth'));

alter table public.chatgpt_accounts
  add column if not exists oauth_client_id text,
  add column if not exists oauth_expires_at timestamptz,
  add column if not exists oauth_refresh_sealed text;

comment on column public.chatgpt_accounts.oauth_client_id is
  'Issued OAuth client_id (oaiapp_…) dari Sign in with ChatGPT untuk akun ini.';
comment on column public.chatgpt_accounts.oauth_expires_at is
  'Kedaluwarsa access token OAuth (1 jam). Dipakai untuk memutuskan kapan refresh.';
comment on column public.chatgpt_accounts.oauth_refresh_sealed is
  'Refresh token OAuth tersegel AES-GCM (30 hari bergulir). Tidak pernah dikirim ke browser.';

alter table public.chatgpt_accounts
  drop constraint if exists chatgpt_accounts_oauth_client_id_check;
alter table public.chatgpt_accounts
  add constraint chatgpt_accounts_oauth_client_id_check
  check (oauth_client_id is null or char_length(oauth_client_id) <= 120);
