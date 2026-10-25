-- Traveler waitlist, saved in the database.
--
-- The website's "Be first on the list" form only emails RVnB (Web3Forms), so
-- there was no list to look back at or to notify when a spot opens. The app's
-- "Join the waitlist" (shown when the map has no spots in view) writes here
-- instead, with where the map was centered, so RVnB can see where travelers
-- are looking and email them when a spot opens nearby.
--
-- Anyone can join (logged in or not). Only the admin can read the list. Each
-- sign-up sends the admin a notification, which send-push delivers to the
-- app and browser like every other notification.

create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  email text not null,
  interest text not null default 'traveler' check (interest in ('traveler', 'host')),
  latitude double precision,
  longitude double precision,
  source text not null default 'app' check (source in ('app', 'web')),
  user_id uuid references auth.users(id) on delete set null,
  constraint waitlist_email_shape check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 200),
  constraint waitlist_name_length check (name is null or char_length(name) <= 100)
);
create unique index if not exists waitlist_signups_email_interest_unique
  on public.waitlist_signups (lower(email), interest);

alter table public.waitlist_signups enable row level security;

drop policy if exists "Anyone can join the waitlist" on public.waitlist_signups;
create policy "Anyone can join the waitlist" on public.waitlist_signups
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists "Admin reads the waitlist" on public.waitlist_signups;
create policy "Admin reads the waitlist" on public.waitlist_signups
  for select using (public.rvnb_is_privileged());

grant insert on public.waitlist_signups to anon, authenticated;
grant select on public.waitlist_signups to authenticated;
grant all on public.waitlist_signups to service_role;

-- Tell the admin about each new sign-up.
create or replace function public.rvnb_notify_waitlist_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
begin
  select id into v_admin from auth.users where lower(email) = 'pierson.willhite@gmail.com';
  if v_admin is null then
    return new;
  end if;
  insert into notifications (user_id, type, title, message, link)
  values (
    v_admin,
    'waitlist_signup',
    'New waitlist sign-up',
    coalesce(nullif(new.name, ''), new.email) || ' (' || new.email || ')'
      || case when new.interest = 'host' then ' has a lot to list' else ' wants a spot' end
      || case when new.latitude is not null
           then ' near ' || round(new.latitude::numeric, 2) || ', ' || round(new.longitude::numeric, 2)
           else '' end,
    'admin.html'
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_waitlist_signup on public.waitlist_signups;
create trigger trg_notify_waitlist_signup
  after insert on public.waitlist_signups
  for each row execute function public.rvnb_notify_waitlist_signup();
