-- Jejak penukaran kode OAuth sekali-pakai.
--
-- Kenapa: `invalid_grant` dari OpenAI tidak memberi detail. Penyebab paling
-- sering adalah kode yang sama ditukar dua kali (halaman /auth/callback dimuat
-- ulang, tab dipulihkan, atau dua tab). Kolom ini menyimpan SIDIK JARI kode
-- (SHA-256, 12 heksadesimal) — bukan kodenya — supaya penukaran ganda bisa
-- ditolak sebelum memanggil OpenAI dan bisa dibedakan dari kegagalan lain.

alter table public.chatgpt_oauth_links
  add column if not exists exchanged_code_fingerprint text;

comment on column public.chatgpt_oauth_links.exchanged_code_fingerprint is
  'SHA-256 (12 hex pertama) kode otorisasi yang sudah ditukar. Mencegah penukaran ganda tanpa menyimpan kode aslinya.';

create index if not exists chatgpt_oauth_links_state_idx
  on public.chatgpt_oauth_links (state) where status = 'pending';
