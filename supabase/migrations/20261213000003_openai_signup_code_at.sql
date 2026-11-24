-- Kapan kode verifikasi tersimpan, terpisah dari kapan pesan verifikasi dicocokkan.
--
-- Kenapa perlu kolom sendiri: kode bisa ditemukan walaupun pengirimnya tidak
-- dikenali sebagai OpenAI. Kasus itu TIDAK boleh menaikkan langkah menjadi
-- "terverifikasi" (belum terbukti itu email OpenAI), tetapi kodenya tetap harus
-- bertahan setelah halaman dimuat ulang. Tanpa kolom ini, satu-satunya waktu
-- yang tersedia adalah verified_at yang sengaja tidak diisi pada kasus tersebut.
--
-- Kolom ini hanya menyimpan WAKTU, bukan kode tambahan; kodenya tetap di
-- verification_code dan tetap bukan kredensial login.

alter table public.openai_signup_attempts
  add column if not exists verification_code_at timestamptz;

comment on column public.openai_signup_attempts.verification_code_at is
  'Waktu kode verifikasi terakhir diekstrak. Dipakai untuk menandai kode yang lewat ±10 menit. Bukan kredensial.';

-- Baris lama: samakan dengan verified_at supaya penanda kedaluwarsa tetap jalan.
update public.openai_signup_attempts
   set verification_code_at = verified_at
 where verification_code_at is null
   and verified_at is not null
   and verification_code <> '';

notify pgrst, 'reload schema';
