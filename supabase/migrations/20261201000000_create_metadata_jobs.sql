-- BLEA AI — media metadata scan & AI-metadata removal jobs
-- Tracks active progress for Live Queue (/live), History (/history),
-- and 100-credit ledger linkage (credit_ledger.generation_id -> metadata_jobs.id).

create table if not exists public.metadata_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  media_kind text not null check (media_kind in ('image', 'video')),
  filename text not null check (char_length(btrim(filename)) between 1 and 260),
  mime_type text not null default '',
  original_size bigint not null default 0 check (original_size >= 0),
  cleaned_size bigint not null default 0 check (cleaned_size >= 0),
  status text not null default 'processing' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  ai_detected boolean not null default false,
  detected_tools jsonb not null default '[]'::jsonb,
  scan_before jsonb not null default '{}'::jsonb,
  scan_after jsonb not null default '{}'::jsonb,
  removed_count integer not null default 0 check (removed_count >= 0),
  cleaned_path text,
  credits_charged integer not null default 0 check (credits_charged >= 0),
  credits_refunded integer not null default 0 check (credits_refunded >= 0 and credits_refunded <= credits_charged),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists metadata_jobs_user_created_idx
  on public.metadata_jobs (user_id, created_at desc);

create index if not exists metadata_jobs_status_idx
  on public.metadata_jobs (status);

drop trigger if exists metadata_jobs_set_updated_at on public.metadata_jobs;
create trigger metadata_jobs_set_updated_at
  before update on public.metadata_jobs
  for each row execute function public.set_projects_updated_at();

alter table public.metadata_jobs enable row level security;
revoke all on table public.metadata_jobs from anon, authenticated;
grant select on table public.metadata_jobs to authenticated;

drop policy if exists metadata_jobs_select_own on public.metadata_jobs;
create policy metadata_jobs_select_own
  on public.metadata_jobs for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists metadata_jobs_admin_select on public.metadata_jobs;
create policy metadata_jobs_admin_select
  on public.metadata_jobs for select to authenticated
  using (public.is_admin());

drop policy if exists metadata_jobs_admin_delete on public.metadata_jobs;
create policy metadata_jobs_admin_delete
  on public.metadata_jobs for delete to authenticated
  using (public.is_admin());
