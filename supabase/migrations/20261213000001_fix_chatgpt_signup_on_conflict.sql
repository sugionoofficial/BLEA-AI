-- Perbaikan 42P10 pada /api/chatgpt-signup.
--
-- Gejala: "Penyimpanan BLEA menolak permintaan (HTTP 400). code 42P10, there is
-- no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Sebab: migrasi awal hanya membuat unique INDEX ekspresi
-- (user_id, lower(email)). PostgreSQL tidak bisa memakai index ekspresi untuk
-- menginferensi kolom ON CONFLICT (user_id, email), sehingga upsert di
-- src/lib/chatgptSignupRoute.js selalu ditolak PostgREST.
--
-- Perbaikan: tambahkan unique CONSTRAINT pada kolom apa adanya. Worker selalu
-- menulis email lowercase (validateSignupInput), jadi tidak ada duplikasi
-- baru; index ekspresi tetap dipertahankan sebagai jaring pengaman.
--
-- Idempoten: aman dijalankan pada database yang sudah diperbaiki manual.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chatgpt_signup_attempts_user_email_unique'
      and conrelid = 'public.chatgpt_signup_attempts'::regclass
  ) then
    alter table public.chatgpt_signup_attempts
      add constraint chatgpt_signup_attempts_user_email_unique unique (user_id, email);
  end if;
end $$;

notify pgrst, 'reload schema';
