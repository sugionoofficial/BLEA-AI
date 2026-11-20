-- Durable at-most-once submission records for the admin's own Freebeat Dance Video tests.
-- This is not a BLEA credit ledger and must not be accessible to browser roles.
create table public.freebeat_admin_dance_tests (
  id uuid primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  session_hash text not null check (session_hash ~ '^[A-Za-z0-9_-]{43}$'),
  music_id text not null check (char_length(music_id) between 1 and 256),
  aspect_ratio text not null check (aspect_ratio in ('16:9', '9:16', '1:1', '4:3', '3:4')),
  auto_mode boolean not null default true,
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
create unique index freebeat_one_unresolved_dance_test_per_admin
  on public.freebeat_admin_dance_tests (admin_id) where status in ('dispatching', 'unknown');
create index freebeat_admin_dance_tests_admin_created on public.freebeat_admin_dance_tests (admin_id, created_at desc);
alter table public.freebeat_admin_dance_tests enable row level security;
revoke all on public.freebeat_admin_dance_tests from public, anon, authenticated;
grant select, insert, update on public.freebeat_admin_dance_tests to service_role;
