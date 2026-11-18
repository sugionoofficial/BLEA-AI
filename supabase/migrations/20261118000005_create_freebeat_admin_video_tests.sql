-- Durable at-most-once submission records for the admin's own Freebeat tests.
-- This is not a BLEA credit ledger and must not be accessible to browser roles.
create table public.freebeat_admin_video_tests (
  id uuid primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[A-Za-z0-9_-]{43}$'),
  model_id bigint not null check (model_id >= 0),
  quote_credits numeric not null check (quote_credits >= 0 and quote_credits <= 1000000),
  max_credits numeric not null check (max_credits = quote_credits),
  status text not null check (status in ('dispatching', 'unknown', 'submitted', 'reviewed')),
  task_id text check (task_id is null or (char_length(task_id) between 1 and 256 and task_id ~ '^[A-Za-z0-9_.:-]+$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'submitted' and task_id is not null) or (status <> 'submitted' and task_id is null))
);
-- An unresolved request blocks the same admin from making another paid request.
-- Never expire this lock automatically: the upstream outcome could be unknown.
create unique index freebeat_one_unresolved_video_test_per_admin
  on public.freebeat_admin_video_tests (admin_id) where status in ('dispatching', 'unknown');
create index freebeat_admin_video_tests_admin_created on public.freebeat_admin_video_tests (admin_id, created_at desc);
alter table public.freebeat_admin_video_tests enable row level security;
revoke all on public.freebeat_admin_video_tests from public, anon, authenticated;
grant select, insert, update on public.freebeat_admin_video_tests to service_role;
