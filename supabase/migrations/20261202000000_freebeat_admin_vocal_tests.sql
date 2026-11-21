-- Durable at-most-once submission records for the admin's own Freebeat Singing & Lip-Sync Video tests.
-- This is not a BLEA credit ledger and must not be accessible to browser roles.
create table public.freebeat_admin_vocal_tests (
  id uuid primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[A-Za-z0-9_-]{43}$'),
  tool_name text not null check (tool_name in ('generate_singing_video', 'generate_lip_sync_video')),
  mode text check (mode is null or (char_length(mode) between 1 and 64)),
  aspect_ratio text check (aspect_ratio is null or aspect_ratio in ('9:16', '16:9', '1:1')),
  duration_seconds numeric null check (duration_seconds is null or (duration_seconds > 0 and duration_seconds <= 600)),
  video_duration_ms integer null check (video_duration_ms is null or (video_duration_ms > 0 and video_duration_ms <= 600000)),
  quote_credits numeric null check (quote_credits is null or (quote_credits >= 0 and quote_credits <= 1000000)),
  max_credits numeric null check (max_credits is null or (max_credits >= 0 and max_credits <= 1000000)),
  accept_unknown_cost boolean not null default false,
  status text not null check (status in ('dispatching', 'unknown', 'submitted', 'reviewed')),
  task_id text check (task_id is null or (char_length(task_id) between 1 and 256 and task_id ~ '^[A-Za-z0-9_.:-]+$')),
  session_url text check (session_url is null or char_length(session_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'submitted' and task_id is not null) or (status <> 'submitted' and task_id is null)),
  check ((accept_unknown_cost = true and max_credits is null) or (accept_unknown_cost = false and max_credits is not null))
);
create unique index freebeat_one_unresolved_vocal_test_per_admin
  on public.freebeat_admin_vocal_tests (admin_id) where status in ('dispatching', 'unknown');
create index freebeat_admin_vocal_tests_admin_created on public.freebeat_admin_vocal_tests (admin_id, created_at desc);
alter table public.freebeat_admin_vocal_tests enable row level security;
revoke all on public.freebeat_admin_vocal_tests from public, anon, authenticated;
grant select, insert, update on public.freebeat_admin_vocal_tests to service_role;
