create table if not exists public.video_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'unorouter',
  model text not null check (char_length(btrim(model)) between 1 and 160),
  prompt text not null default '' check (char_length(prompt) <= 4000),
  aspect_ratio text not null default '16:9',
  resolution text not null default '720p',
  duration integer not null default 5 check (duration between 1 and 120),
  generate_audio boolean not null default true,
  image_url text,
  video_url text,
  audio_url text,
  external_job_id text,
  polling_url text,
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'completed', 'failed', 'cancelled', 'expired')),
  progress integer not null default 0 check (progress between 0 and 100),
  result_url text,
  upstream_result_url text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists video_generations_user_created_idx
  on public.video_generations (user_id, created_at desc);

create index if not exists video_generations_status_idx
  on public.video_generations (status);

drop trigger if exists video_generations_set_updated_at on public.video_generations;
create trigger video_generations_set_updated_at
  before update on public.video_generations
  for each row execute function public.set_projects_updated_at();

alter table public.video_generations enable row level security;
revoke all on table public.video_generations from anon, authenticated;
grant select, insert, update, delete on table public.video_generations to authenticated;

create policy video_generations_select_own
  on public.video_generations for select to authenticated
  using (auth.uid() = user_id);

create policy video_generations_insert_own
  on public.video_generations for insert to authenticated
  with check (auth.uid() = user_id);

create policy video_generations_update_own
  on public.video_generations for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy video_generations_delete_own
  on public.video_generations for delete to authenticated
  using (auth.uid() = user_id);

create policy video_generations_admin_select
  on public.video_generations for select to authenticated
  using (public.is_admin());

create policy video_generations_admin_delete
  on public.video_generations for delete to authenticated
  using (public.is_admin());
