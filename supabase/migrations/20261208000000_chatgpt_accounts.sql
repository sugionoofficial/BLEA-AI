-- BLEA AI — pool akun ChatGPT/OpenAI yang ditambahkan MANUAL oleh admin.
--
-- Kenapa manual: OpenAI tidak menyediakan API pendaftaran akun. Satu-satunya
-- cara membuat akun otomatis adalah mengotomasi halaman signup mereka, yang
-- melanggar ketentuan layanan dan langsung mati oleh captcha. Karena itu BLEA
-- TIDAK mendaftarkan akun. Admin menambahkan sendiri akun yang sudah ia miliki
-- (email + kredensial resmi), lalu worker memakainya bergiliran.
--
-- Pola tabel ini sama dengan pool freebeat (freebeat_oauth_accounts) dan
-- provider_key_pool: prioritas naik, kuota harian per akun, cooldown saat akun
-- kena batas/rate limit, lalu lanjut ke akun berikutnya.
--
-- Kredensial disimpan TERSEGEL (AES-GCM dengan PROVIDER_CREDENTIAL_ENCRYPTION_KEY)
-- dan hanya dibaca server-side lewat service_role. Baris tidak pernah dikirim
-- ke browser: halaman admin hanya menerima sidik jari (token_hint).

create table if not exists public.chatgpt_accounts (
  id uuid primary key default gen_random_uuid(),
  account_email text not null default '' check (char_length(account_email) <= 320),
  account_label text not null default '' check (char_length(account_label) <= 100),
  -- Jenis kredensial:
  --   'api_key'  → kunci resmi dari platform.openai.com (dipakai ke /v1/*)
  --   'session'  → token sesi ChatGPT (chatgpt.com/api/auth/session)
  --                Disimpan sebagai catatan/koneksi milik admin; TIDAK dipakai
  --                untuk memanggil backend non-publik, karena itu melanggar
  --                ToS dan akunnya berisiko ditutup.
  --   'oauth'    → hasil "Continue with ChatGPT" (Sign in with ChatGPT). Tidak
  --                ada API key; token hanya sah untuk Responses API teks.
  credential_kind text not null default 'api_key' check (credential_kind in ('api_key', 'session', 'oauth')),
  -- Kolom khusus OAuth: client_id terbitan OpenAI per akun, masa berlaku access
  -- token (1 jam), dan refresh token tersegel (30 hari bergulir).
  oauth_client_id text check (char_length(oauth_client_id) <= 120),
  oauth_expires_at timestamptz,
  oauth_refresh_sealed text,
  api_base text not null default 'https://api.openai.com' check (char_length(api_base) <= 300),
  model_default text not null default 'gpt-4o-mini' check (char_length(model_default) <= 120),
  -- Isolasi kapabilitas: akun hanya boleh dipakai tool yang tercantum di sini.
  -- Worker menolak permintaan tool di luar daftar, jadi satu akun tidak bisa
  -- dipakai tool lain "kebetulan" karena kebijakan pemilihan longgar.
  capabilities text[] not null default '{chat}'::text[],
  sealed_token text not null check (char_length(sealed_token) between 10 and 6000),
  token_hint text not null default '' check (char_length(token_hint) <= 24),
  enabled boolean not null default true,
  priority integer not null default 100 check (priority between 0 and 100000),
  -- Kuota harian per akun (0 = tanpa batas). Tanggal dihitung pada zona WIB.
  daily_limit integer not null default 200 check (daily_limit between 0 and 1000000),
  used_today integer not null default 0 check (used_today >= 0),
  quota_date date not null default (now() at time zone 'Asia/Jakarta')::date,
  consecutive_failures integer not null default 0,
  cooldown_until timestamptz,
  last_error text,
  last_ok_at timestamptz,
  last_test_at timestamptz,
  last_test_ok boolean,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.chatgpt_accounts is
  'Manual ChatGPT/OpenAI account pool with per-account daily quota and round-robin failover (worker service_role only).';

comment on column public.chatgpt_accounts.sealed_token is
  'AES-GCM sealed credential (AES key derived from PROVIDER_CREDENTIAL_ENCRYPTION_KEY). Never sent to the browser.';

create index if not exists chatgpt_accounts_lookup_idx
  on public.chatgpt_accounts (enabled, priority, created_at);

create index if not exists chatgpt_accounts_email_idx
  on public.chatgpt_accounts (lower(account_email));

drop trigger if exists chatgpt_accounts_set_updated_at on public.chatgpt_accounts;
create trigger chatgpt_accounts_set_updated_at
  before update on public.chatgpt_accounts
  for each row execute function public.set_projects_updated_at();

alter table public.chatgpt_accounts enable row level security;
-- Sama seperti freebeat_oauth_accounts: tidak ada akses langsung dari klien.
-- Semua akses lewat Worker (service_role) setelah memeriksa peran admin.
revoke all on table public.chatgpt_accounts from anon, authenticated;
