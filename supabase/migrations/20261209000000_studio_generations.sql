-- BLEA AI — hasil OpenAI untuk tool Studio (gambar/video/audio/teks)
--
-- Kenapa perlu tabel sendiri, bukan meneruskan ke freebeat:
--   Pool akun OpenAI menghasilkan output yang harus tetap bisa diambil
--   pengguna (unduh/copy) tanpa bergantung pada provider lain. Setiap baris
--   mencatat tool mana yang membuatnya, model OpenAI yang dipakai, dan status
--   kuota/akun — sehingga halaman Hasil & Unduhan tetap akurat dan isolasi
--   kapabilitas tidak perlu ditebak dari isi kolom.
--
-- Kolom `kind` sengaja dibatasi ke kapabilitas tool Studio. `text` dipakai chat
-- & agen, `image` ruang gambar, `video` ruang video, `audio` transkrip/TTS.

create table if not exists public.studio_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('text', 'image', 'video', 'audio')),
  tool text not null default 'chat' check (char_length(tool) between 1 and 40),
  provider text not null default 'openai' check (char_length(provider) between 1 and 40),
  model text not null default '' check (char_length(model) <= 160),
  prompt text not null default '' check (char_length(prompt) <= 8000),
  output_text text,
  media_url text,
  download_url text,
  status text not null default 'completed' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  error_message text,
  openai_account_id uuid,
  openai_account_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.studio_generations is
  'Hasil tool Studio yang dibuat lewat pool akun OpenAI (gambar/video/audio/teks), dipakai halaman Hasil & Unduhan.';

create index if not exists studio_generations_user_created_idx
  on public.studio_generations (user_id, created_at desc);

create index if not exists studio_generations_user_kind_idx
  on public.studio_generations (user_id, kind, created_at desc);

drop trigger if exists studio_generations_set_updated_at on public.studio_generations;
create trigger studio_generations_set_updated_at
  before update on public.studio_generations
  for each row execute function public.set_projects_updated_at();

alter table public.studio_generations enable row level security;
revoke all on table public.studio_generations from anon, authenticated;
grant select on table public.studio_generations to authenticated;

drop policy if exists studio_generations_select_own on public.studio_generations;
create policy studio_generations_select_own
  on public.studio_generations for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists studio_generations_admin_select on public.studio_generations;
create policy studio_generations_admin_select
  on public.studio_generations for select to authenticated
  using (public.is_admin());

drop policy if exists studio_generations_admin_delete on public.studio_generations;
create policy studio_generations_admin_delete
  on public.studio_generations for delete to authenticated
  using (public.is_admin());
