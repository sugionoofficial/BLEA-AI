# Admin access

BLEA AI admin access is controlled by a Supabase **App Metadata** claim, not editable user metadata. The application checks `user.app_metadata.role === "admin"`; database RLS checks the same trusted JWT claim through `public.is_admin()`.

## Promote the first administrator

1. Create and confirm the account through the deployed `/signup` page.
2. In Supabase Dashboard → SQL Editor, run this query with that account's email:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', 'admin')
where lower(email) = lower('admin@example.com')
returning id, email;
```

3. Confirm one row was returned, then sign out and back in so the session receives the updated App Metadata claim.
4. Open `/admin`.

Do not assign the role through `user_metadata` or from the browser. Regular accounts cannot change `app_metadata`.

## Data access

The admin console reads profiles, projects, conversation metadata, and waitlist entries through the regular Supabase client. Row Level Security permits cross-user reads/deletes only when the verified JWT contains the admin claim. Chat message contents remain private to each account; an administrator can delete a conversation but cannot read its messages. The `service_role` key is not used in the browser.
