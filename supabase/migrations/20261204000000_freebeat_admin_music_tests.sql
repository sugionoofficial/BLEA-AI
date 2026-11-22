-- Durable at-most-once submission records for the admin's own Freebeat Music generation tests.
-- This is not a BLEA credit ledger and must not be accessible to browser roles.
create table public.freebeat_admin_music_tests (
  id uuid primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[A-Za-z0-9_-]{43}$'),
  model_id integer not null check (model_id > 0),
  model_name text check (model_name is null or (char_length(model_name) between 1 and 200)),
  instrumental boolean not null default false,
  has_lyrics boolean not null default false,
  duration_seconds numeric null check (duration_seconds is null or (duration_seconds >= 10 and duration_seconds <= 300)),
  quote_credits numeric not null check (quote_credits >= 0 and quote_credits <= 1000000),
  max_credits numeric not null check (max_credits >= 0 and max_credits <= 1000000 and max_credits >= quote_credits),
  status text not null check (status in ('dispatching', 'unknown', 'submitted', 'reviewed')),
  task_id text check (task_id is null or (char_length(task_id) between 1 and 256 and task_id ~ '^[A-Za-z0-9_.:-]+$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'submitted' and task_id is not null) or (status <> 'submitted' and task_id is null))
);
create unique index freebeat_one_unresolved_music_test_per_admin
  on public.freebeat_admin_music_tests (admin_id) where status in ('dispatching', 'unknown');
create index freebeat_admin_music_tests_admin_created on public.freebeat_admin_music_tests (admin_id, created_at desc);
alter table public.freebeat_admin_music_tests enable row level security;
revoke all on public.freebeat_admin_music_tests from public, anon, authenticated;
grant select, insert, update on public.freebeat_admin_music_tests to service_role;
