-- Push notifications for the iOS/Android app, and live chat.
--
-- push_subscriptions holds the website's Web Push subscriptions; the app's
-- Expo push tokens go here. send-push (fired by the notifications trigger)
-- now delivers to both, so every existing notification type — new booking
-- request, confirmed/declined, cancellation, new message, listing approved —
-- reaches the app too.

create table if not exists public.expo_push_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text,
  updated_at timestamptz not null default now()
);

create index if not exists expo_push_tokens_user_id_idx on public.expo_push_tokens (user_id);

alter table public.expo_push_tokens enable row level security;

drop policy if exists "Users can view their own push tokens" on public.expo_push_tokens;
create policy "Users can view their own push tokens"
  on public.expo_push_tokens for select
  using (auth.uid() = user_id);

-- Registration goes through these functions rather than direct inserts: a
-- phone's token follows whoever is signed in on it, so a token last used by
-- another account has to move to the new one, which RLS alone can't allow.
create or replace function public.register_expo_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[.+\]$' then
    raise exception 'Invalid push token';
  end if;
  insert into expo_push_tokens (token, user_id, platform, updated_at)
  values (p_token, auth.uid(), left(p_platform, 20), now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end;
$$;

-- Called on sign-out so the phone stops getting the account's notifications.
create or replace function public.unregister_expo_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from expo_push_tokens where token = p_token and user_id = auth.uid();
$$;

revoke all on function public.register_expo_push_token(text, text) from public;
revoke all on function public.unregister_expo_push_token(text) from public;
grant execute on function public.register_expo_push_token(text, text) to authenticated;
grant execute on function public.unregister_expo_push_token(text) to authenticated;

-- Live chat: stream new messages to the people in the conversation.
-- Realtime applies the messages RLS policies, so each person only receives
-- rows for bookings they're part of.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
