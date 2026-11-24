-- BLEA AI — permintaan pendaftaran akun OpenAI yang memakai email TempMail.
--
-- Konteks: halaman admin /studio/openai-accounts memberi tombol "Daftar dengan
-- email TempMail". Tabel ini menyimpan JEJAK permintaan itu, bukan akun OpenAI
-- dan bukan kredensial apa pun.
--
-- Yang TIDAK ada di sini (dan tidak akan ditambahkan):
--   • kata sandi / passkey / kode verifikasi,
--   • cookie sesi konsumen atau token `__Secure-next-auth.session-token`,
--   • salinan isi email verifikasi (hanya id pesan inbox yang dicocokkan).
--
-- Alasan: pendaftaran otomatis lewat POST endpoint authentikasi privat
-- tidak bisa dijalankan dari Worker (domain itu diblokir untuk Workerd) dan
-- melanggar Terms of Use OpenAI. Tabel ini hanya mencatat langkah manual yang
-- benar-benar dilakukan admin, plus hasil pencocokan pesan verifikasi.
--
-- Satu baris per (user_id, email): mengulang alamat yang sama akan memperbarui
-- baris, bukan menumpuk riwayat pendaftaran palsu.

create table if not exists public.openai_signup_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  -- URL halaman daftar resmi yang dibuka (berisi login_hint = email di atas).
  signup_url text not null default '' check (char_length(signup_url) <= 1000),
  -- dibuka              → URL diberikan ke browser, admin yang menekan tombol
  -- email_dikirim       → admin menyatakan formulir sudah dikirim
  -- menunggu_verifikasi → menunggu email verifikasi di inbox TempMail
  -- terverifikasi       → pesan verifikasi yang cocok ditemukan di inbox
  -- dilewati            → admin berhenti (mis. alamat +tag ditolak OpenAI)
  step text not null default 'dibuka'
    check (step in ('dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi', 'dilewati')),
  note text not null default '' check (char_length(note) <= 500),
  -- id pesan inbox (mail.tm message id / Gmail message id) yang cocok.
  verification_message_id text not null default '' check (char_length(verification_message_id) <= 200),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.openai_signup_attempts is
  'Jejak permintaan pendaftaran OpenAI dari email TempMail (tanpa kredensial). Satu baris per pengguna+email.';

-- Unik per (admin, email). WAJIB berupa unique CONSTRAINT pada kolom apa adanya:
-- Worker melakukan upsert lewat PostgREST `on_conflict=user_id,email`, dan
-- ON CONFLICT hanya bisa menginferensi index/constraint yang kolomnya persis
-- sama. Index ekspresi (user_id, lower(email)) TIDAK bisa dipakai dan membuat
-- upsert gagal dengan 42P10 ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification"). Worker selalu menulis email
-- lowercase, jadi kunci ini cukup.
alter table public.openai_signup_attempts
  add constraint openai_signup_attempts_user_email_unique unique (user_id, email);

-- Jaring pengaman untuk baris lama yang mungkin tersimpan dengan huruf besar.
create unique index if not exists openai_signup_attempts_user_email_lower_key
  on public.openai_signup_attempts (user_id, lower(email));

create index if not exists openai_signup_attempts_user_created_idx
  on public.openai_signup_attempts (user_id, created_at desc);

drop trigger if exists openai_signup_attempts_set_updated_at on public.openai_signup_attempts;
create trigger openai_signup_attempts_set_updated_at
  before update on public.openai_signup_attempts
  for each row execute function public.set_projects_updated_at();

-- RLS: pengguna hanya bisa membaca barisnya sendiri; semua tulis lewat Worker
-- (service_role) setelah JWT admin diperiksa. Tidak ada insert/update klien.
alter table public.openai_signup_attempts enable row level security;
revoke all on table public.openai_signup_attempts from anon, authenticated;
grant select on table public.openai_signup_attempts to authenticated;

drop policy if exists openai_signup_attempts_select_own on public.openai_signup_attempts;
create policy openai_signup_attempts_select_own on public.openai_signup_attempts
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists openai_signup_attempts_admin_select on public.openai_signup_attempts;
create policy openai_signup_attempts_admin_select on public.openai_signup_attempts
  for select to authenticated using (public.is_admin());
