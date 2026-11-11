create policy ai_messages_admin_delete
  on public.ai_messages for delete to authenticated
  using (public.is_admin());
