-- Kolom kode verifikasi untuk "Daftar akun OpenAI dengan email TempMail".
--
-- Kenapa perlu: email verifikasi OpenAI berisi KODE (bukan tautan yang cukup
-- diklik), dan kode itu harus ditempel kembali di tab platform OpenAI. Tanpa kolom ini
-- admin harus membuka pesan di TempMail dan menyalin manual; dengan kolom ini
-- panel bisa menampilkan kode + tombol salin.
--
-- Batasan penyimpanan: kode ini BUKAN kredensial login, hanya bukti sekali
-- pakai yang dikirim ke email milik admin sendiri. Tidak ada token/sesi yang
-- disimpan. Kolom dikosongkan kembali bila pendaftaran diulang.

alter table public.openai_signup_attempts
  add column if not exists verification_code text not null default ''
  check (char_length(verification_code) <= 12);

comment on column public.openai_signup_attempts.verification_code is
  'Kode verifikasi sekali pakai dari email OpenAI, untuk ditempel manual di tab platform OpenAI. Bukan kredensial login.';

notify pgrst, 'reload schema';
