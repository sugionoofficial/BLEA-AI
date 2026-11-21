-- BLEA AI — tambahkan provider_key_id pada image_generations (seperti video_generations)
-- serta dukung status 'cancelled' agar admin dapat membatalkan proses gambar yang menggantung.

alter table public.image_generations
  add column if not exists provider_key_id uuid;

alter table public.image_generations
  drop constraint if exists image_generations_status_check;

alter table public.image_generations
  add constraint image_generations_status_check
  check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'unknown'));
