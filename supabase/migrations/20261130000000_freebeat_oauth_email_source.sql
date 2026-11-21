-- Tambah metadata asal email & subject OAuth pada pool akun Freebeat
-- agar pembaruan email hasil OAuth dapat dibedakan dari label manual/backfill.

alter table public.freebeat_oauth_accounts
  add column if not exists email_source text not null default 'manual',
  add column if not exists oauth_subject text;
