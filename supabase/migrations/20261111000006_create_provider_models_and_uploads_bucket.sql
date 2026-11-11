-- BLEA AI — provider model availability + AI Studio file uploads
--
-- 1) provider_models: daftar model per provider dengan status aktif.
--    Admin panel (API key) memakai ini untuk mengaktifkan/menonaktifkan
--    model yang muncul di AI Studio. RLS admin-only.
-- 2) storage bucket ai-studio-uploads: tempat upload foto/video/file
--    (maks 30MB per file). Public read agar model bisa mengambil URL;
--    insert/update/delete oleh user terautentikasi (path per-user).

create table if not exists public.provider_models (
  provider text not null default 'unorouter',
  model text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);

create trigger provider_models_set_updated_at
  before update on public.provider_models
  for each row execute function public.set_projects_updated_at();

alter table public.provider_models enable row level security;
revoke all on table public.provider_models from anon, authenticated;
grant select, insert, update, delete on table public.provider_models to authenticated;

create policy provider_models_admin_select on public.provider_models
  for select to authenticated using (is_admin());
create policy provider_models_admin_insert on public.provider_models
  for insert to authenticated with check (is_admin());
create policy provider_models_admin_update on public.provider_models
  for update to authenticated using (is_admin()) with check (is_admin());
create policy provider_models_admin_delete on public.provider_models
  for delete to authenticated using (is_admin());

-- Seed: satu model gratis aktif sebagai default.
insert into public.provider_models (provider, model, active)
select 'unorouter', 'gpt-oss-120b:free', true
where not exists (
  select 1 from public.provider_models where provider = 'unorouter' and model = 'gpt-oss-120b:free'
);

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public)
values ('ai-studio-uploads', 'ai-studio-uploads', true)
on conflict (id) do nothing;

create policy "ai-studio-uploads public read" on storage.objects
  for select using (bucket_id = 'ai-studio-uploads');

create policy "ai-studio-uploads auth insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ai-studio-uploads');

create policy "ai-studio-uploads owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'ai-studio-uploads' and (storage.objects.name)::text like (auth.uid()::text || '/%'))
  with check (bucket_id = 'ai-studio-uploads' and (storage.objects.name)::text like (auth.uid()::text || '/%'));

create policy "ai-studio-uploads owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'ai-studio-uploads' and (storage.objects.name)::text like (auth.uid()::text || '/%'));
