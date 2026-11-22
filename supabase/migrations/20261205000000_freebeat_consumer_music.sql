-- Consumer Freebeat Music Generation (generate_music):
-- 1) Expand credit_model_prices.modality check constraint to allow 'music'.
-- 2) Create music_generations table (service_role writes; users can select own rows).
-- 3) Seed verified model #129 (Lyria 3 Pro) active & priced (editable in Admin -> Katalog Model).

alter table public.credit_model_prices
  drop constraint if exists credit_model_prices_modality_check;

alter table public.credit_model_prices
  add constraint credit_model_prices_modality_check
  check (
    modality in (
      'image',
      'image_edit',
      'image_edit_2k',
      'video',
      'music',
      'text',
      'speech',
      'embedding',
      'other'
    )
  );

create table if not exists public.music_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'freebeat',
  model text not null check (char_length(btrim(model)) between 1 and 160),
  model_name text,
  prompt text not null default '' check (char_length(prompt) <= 2000),
  lyrics text check (lyrics is null or char_length(lyrics) <= 12000),
  instrumental boolean not null default false,
  duration_seconds numeric check (duration_seconds is null or (duration_seconds >= 10 and duration_seconds <= 300)),
  credits_charged integer not null default 0 check (credits_charged >= 0),
  credits_refunded integer not null default 0 check (credits_refunded >= 0),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'unknown')),
  title text,
  music_id text,
  audio_url text,
  cover_url text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  external_job_id text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists music_generations_user_created_idx
  on public.music_generations (user_id, created_at desc);

create index if not exists music_generations_status_idx
  on public.music_generations (status);

drop trigger if exists music_generations_set_updated_at on public.music_generations;
create trigger music_generations_set_updated_at
  before update on public.music_generations
  for each row execute function public.set_projects_updated_at();

alter table public.music_generations enable row level security;
revoke all on table public.music_generations from anon, authenticated;
grant select on table public.music_generations to authenticated;
grant all on table public.music_generations to service_role;

create policy music_generations_select_own
  on public.music_generations for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

insert into public.provider_models (provider, model, active)
values ('freebeat', '129', true)
on conflict (provider, model) do update
  set active = true;

insert into public.credit_model_prices (provider, model, modality, credits, active)
values ('freebeat', '129', 'music', 1000, true)
on conflict (provider, model, modality) do update
  set credits = excluded.credits, active = true;
