-- Report and Block (App Store Guideline 1.2: apps with user content need a
-- way to report objectionable content and to block abusive users, and the
-- developer must act on reports).
--
-- content_reports: anyone signed in can report a listing, a review, a
-- message or a person. The admin gets a notification (and so a push) right
-- away, and works the reports from admin.html / the app's admin screen.
--
-- user_blocks: blocking someone stops messages in both directions (enforced
-- here, not just in the app) and the app hides their listings and messages.

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('listing', 'review', 'message', 'user')),
  listing_id uuid references public.partners(id) on delete set null,
  review_id uuid references public.reviews(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  reported_user_id uuid references public.profiles(id) on delete set null,
  reason text not null check (reason in ('spam', 'inappropriate', 'harassment', 'scam', 'unsafe', 'other')),
  details text check (details is null or char_length(details) <= 1000),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  admin_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists content_reports_open_idx on public.content_reports (created_at desc) where status = 'open';

alter table public.content_reports enable row level security;

drop policy if exists content_reports_insert_own on public.content_reports;
create policy content_reports_insert_own on public.content_reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open' and admin_note is null and resolved_at is null);

drop policy if exists content_reports_select on public.content_reports;
create policy content_reports_select on public.content_reports
  for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.rvnb_is_admin()));

drop policy if exists content_reports_admin_update on public.content_reports;
create policy content_reports_admin_update on public.content_reports
  for update to authenticated
  using ((select public.rvnb_is_admin())) with check ((select public.rvnb_is_admin()));

revoke all on public.content_reports from anon;
grant select, insert, update on public.content_reports to authenticated;
grant all on public.content_reports to service_role;

-- Fill in who is being reported (the message sender, the listing's host),
-- since the reporter can't always read that, then tell the admin.
create or replace function public.rvnb_content_report_before()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reported_user_id is null then
    if new.message_id is not null then
      select sender_id into new.reported_user_id from messages where id = new.message_id;
    elsif new.listing_id is not null then
      select host_id into new.reported_user_id from partners where id = new.listing_id;
    end if;
  end if;
  if new.listing_id is null and new.review_id is not null then
    select partner_id into new.listing_id from reviews where id = new.review_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_content_report_before on public.content_reports;
create trigger trg_content_report_before
  before insert on public.content_reports
  for each row execute function public.rvnb_content_report_before();

create or replace function public.rvnb_notify_content_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
  v_what text;
begin
  select id into v_admin from auth.users where lower(email) = 'pierson.willhite@gmail.com';
  if v_admin is null then
    return new;
  end if;
  v_what := case new.kind
    when 'listing' then 'a listing'
    when 'review' then 'a review'
    when 'message' then 'a message'
    else 'a user' end;
  insert into notifications (user_id, type, title, message, link)
  values (
    v_admin,
    'content_report',
    'New report: ' || v_what,
    'Reason: ' || new.reason || coalesce(' — ' || left(new.details, 120), '') || '. Review it within 24 hours.',
    'admin.html'
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_content_report on public.content_reports;
create trigger trg_notify_content_report
  after insert on public.content_reports
  for each row execute function public.rvnb_notify_content_report();

-- Blocks.
create table if not exists public.user_blocks (
  blocker_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  -- What the blocker saw when they blocked (a host's spot name or a guest's
  -- name), for the "Blocked people" list; people can't read each other's profiles.
  blocked_label text check (blocked_label is null or char_length(blocked_label) <= 120),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.user_blocks enable row level security;

drop policy if exists user_blocks_own on public.user_blocks;
create policy user_blocks_own on public.user_blocks
  for all to authenticated
  using (blocker_id = (select auth.uid()))
  with check (blocker_id = (select auth.uid()));

revoke all on public.user_blocks from anon;
grant select, insert, delete on public.user_blocks to authenticated;
grant all on public.user_blocks to service_role;

-- True when either side of this booking has blocked the other.
create or replace function public.rvnb_booking_blocked(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from bookings b
    join partners p on p.id = b.partner_id
    join user_blocks ub
      on (ub.blocker_id = b.traveler_id and ub.blocked_id = p.host_id)
      or (ub.blocker_id = p.host_id and ub.blocked_id = b.traveler_id)
    where b.id = p_booking_id
  );
$$;

revoke all on function public.rvnb_booking_blocked(uuid) from public, anon;
grant execute on function public.rvnb_booking_blocked(uuid) to authenticated, service_role;

-- No new messages on a booking once either person has blocked the other.
drop policy if exists messages_not_blocked on public.messages;
create policy messages_not_blocked on public.messages
  as restrictive for insert to authenticated
  with check (not (select public.rvnb_booking_blocked(booking_id)));

-- Admin view of reports with what was reported (the admin can't read other
-- people's messages directly, so this is a SECURITY DEFINER function).
create or replace function public.rvnb_admin_reports(p_status text default 'open')
returns table (
  id uuid, kind text, reason text, details text, status text, created_at timestamptz,
  reporter_email text, reported_email text, reported_name text,
  listing_id uuid, listing_name text, review_comment text, message_body text, admin_note text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.rvnb_is_admin() then
    raise exception 'admin only';
  end if;
  return query
  select r.id, r.kind, r.reason, r.details, r.status, r.created_at,
    ru.email::text, tu.email::text, coalesce(tp.full_name, tu.email)::text,
    r.listing_id, p.business_name, rv.comment, m.body, r.admin_note
  from content_reports r
  left join auth.users ru on ru.id = r.reporter_id
  left join auth.users tu on tu.id = r.reported_user_id
  left join profiles tp on tp.id = r.reported_user_id
  left join partners p on p.id = r.listing_id
  left join reviews rv on rv.id = r.review_id
  left join messages m on m.id = r.message_id
  where p_status = 'all' or r.status = p_status
  order by r.created_at desc;
end;
$$;

-- Admin actions on a report: dismiss, resolve, or take the content down.
create or replace function public.rvnb_admin_act_on_report(p_report_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r content_reports;
begin
  if not public.rvnb_is_admin() then
    raise exception 'admin only';
  end if;
  select * into r from content_reports where id = p_report_id;
  if r.id is null then
    raise exception 'report not found';
  end if;
  if p_action = 'remove_review' and r.review_id is not null then
    delete from reviews where id = r.review_id;
  elsif p_action = 'remove_message' and r.message_id is not null then
    delete from messages where id = r.message_id;
  elsif p_action = 'pause_listing' and r.listing_id is not null then
    update partners set status = 'paused', paused_by_admin = true where id = r.listing_id;
  elsif p_action not in ('resolve', 'dismiss') then
    raise exception 'unknown action %', p_action;
  end if;
  update content_reports
  set status = case when p_action = 'dismiss' then 'dismissed' else 'resolved' end,
      admin_note = coalesce(p_note, case when p_action in ('resolve', 'dismiss') then admin_note else p_action end),
      resolved_at = now()
  where id = p_report_id;
end;
$$;

revoke all on function public.rvnb_admin_reports(text) from public, anon;
revoke all on function public.rvnb_admin_act_on_report(uuid, text, text) from public, anon;
grant execute on function public.rvnb_admin_reports(text) to authenticated;
grant execute on function public.rvnb_admin_act_on_report(uuid, text, text) to authenticated;
