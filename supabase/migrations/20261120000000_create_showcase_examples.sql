-- Contoh konten (showcase) untuk dashboard pengguna biasa.
-- Admin mengelola entri (gambar/video + prompt); pengguna hanya dapat melihat
-- dan menyalin prompt. Tidak ada endpoint unduh; berkas disimpan di
-- ai-studio-uploads (publik) atau URL HTTPS lain yang ditempel admin.
create table if not exists public.showcase_examples (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('image', 'video')),
  title text not null default '',
  prompt text not null default '',
  media_url text not null default '',
  poster_url text not null default '',
  sort_order int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists showcase_examples_sort_idx on public.showcase_examples (published, sort_order, created_at desc);

create trigger showcase_examples_set_updated_at
  before update on public.showcase_examples
  for each row execute function public.set_projects_updated_at();

alter table public.showcase_examples enable row level security;
revoke all on table public.showcase_examples from anon, authenticated;
grant select on table public.showcase_examples to authenticated;
grant insert, update, delete on table public.showcase_examples to authenticated;

create policy showcase_select_published on public.showcase_examples
  for select to authenticated
  using (published or public.is_admin());
create policy showcase_admin_insert on public.showcase_examples
  for insert to authenticated
  with check (public.is_admin());
create policy showcase_admin_update on public.showcase_examples
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy showcase_admin_delete on public.showcase_examples
  for delete to authenticated
  using (public.is_admin());
