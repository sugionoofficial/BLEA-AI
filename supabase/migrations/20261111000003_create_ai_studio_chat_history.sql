create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  title text not null default 'Percakapan baru' check (char_length(btrim(title)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(btrim(content)) between 1 and 20000),
  created_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_updated_idx
  on public.ai_conversations (user_id, updated_at desc);
create index if not exists ai_messages_conversation_created_idx
  on public.ai_messages (conversation_id, created_at asc);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
revoke all on table public.ai_conversations, public.ai_messages from anon, authenticated;
grant select, insert, update, delete on table public.ai_conversations, public.ai_messages to authenticated;

create policy ai_conversations_select_own
  on public.ai_conversations for select to authenticated
  using (user_id = auth.uid());
create policy ai_conversations_insert_own
  on public.ai_conversations for insert to authenticated
  with check (user_id = auth.uid());
create policy ai_conversations_update_own
  on public.ai_conversations for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ai_conversations_delete_own
  on public.ai_conversations for delete to authenticated
  using (user_id = auth.uid());
create policy ai_conversations_admin_select
  on public.ai_conversations for select to authenticated
  using (public.is_admin());
create policy ai_conversations_admin_delete
  on public.ai_conversations for delete to authenticated
  using (public.is_admin());

create policy ai_messages_select_own
  on public.ai_messages for select to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );
create policy ai_messages_insert_own
  on public.ai_messages for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );
create policy ai_messages_delete_own
  on public.ai_messages for delete to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.ai_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );
