-- New rep pay (2026-10-26): $5 when a listing goes live, plus $5 for each of
-- its first 3 months (30-day periods after approval) that it's still listed
-- at the end of the month, but only if it gets at least one booking in those
-- first 3 months. No booking means just the $5. Max $20 per new host. The
-- old $15 first-stay bonus is retired.
--
-- "Listed at the end of month k" needs history, not just today's status, so
-- every status change is now recorded in partner_status_log.

-- Status history ------------------------------------------------------------
create table if not exists public.partner_status_log (
  id bigint generated always as identity primary key,
  partner_id uuid not null references public.partners(id) on delete cascade,
  status text not null,
  changed_at timestamptz not null default now()
);
create index if not exists partner_status_log_partner_idx on public.partner_status_log (partner_id, changed_at);
alter table public.partner_status_log enable row level security;
drop policy if exists "Admin reads listing status history" on public.partner_status_log;
create policy "Admin reads listing status history" on public.partner_status_log
  for select using (public.rvnb_is_privileged());
grant select on public.partner_status_log to authenticated;
grant all on public.partner_status_log to service_role;

create or replace function public.rvnb_log_partner_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into partner_status_log (partner_id, status) values (new.id, new.status);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_log_partner_status on public.partners;
create trigger trg_log_partner_status
  after insert or update of status on public.partners
  for each row execute function public.rvnb_log_partner_status();

-- Backfill: listings that went live start their history at approval; their
-- current status, if different, is recorded as of now.
insert into public.partner_status_log (partner_id, status, changed_at)
select id, 'approved', approved_at from public.partners
 where approved_at is not null
   and not exists (select 1 from public.partner_status_log l where l.partner_id = partners.id);
insert into public.partner_status_log (partner_id, status, changed_at)
select p.id, p.status, now() from public.partners p
 where not exists (select 1 from public.partner_status_log l where l.partner_id = p.id and l.status = p.status);

-- Was the listing live (approved) at this moment?
create or replace function public.rvnb_listed_at(p_partner uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select status = 'approved' from partner_status_log
     where partner_id = p_partner and changed_at <= p_at
     order by changed_at desc, id desc limit 1
  ), false)
$$;
revoke all on function public.rvnb_listed_at(uuid, timestamptz) from public, anon, authenticated;

-- Rep rates ---------------------------------------------------------------
alter table public.sales_reps add column if not exists monthly_bonus numeric(10,2) not null default 5;
alter table public.sales_reps add column if not exists trail_months int not null default 3;
alter table public.sales_reps alter column approve_bonus set default 5;
alter table public.sales_reps alter column first_stay_bonus set default 0;
-- Existing reps move to the new plan.
update public.sales_reps set approve_bonus = 5, monthly_bonus = 5, trail_months = 3, first_stay_bonus = 0;

-- Earnings ------------------------------------------------------------------
drop function if exists public.rvnb_admin_rep_summary();
drop function if exists public.rvnb_rep_listings(uuid);

create function public.rvnb_rep_listings(p_rep uuid)
returns table (
  listing_id uuid, business_name text, city text, state text, status text,
  submitted_at timestamptz, approved_at timestamptz,
  first_booking_at date,      -- first charged booking within the trail window
  trail_unlocked boolean,     -- had a booking in the first trail_months months
  months_elapsed int,         -- full 30-day months since approval, capped at trail_months
  months_earned int,          -- months that pay: ended, listed at month end, trail unlocked
  earned numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select p.*, r.approve_bonus, r.monthly_bonus, r.trail_months,
           (select min(b.check_in) from bookings b
             where b.partner_id = p.id
               and b.status in ('confirmed', 'completed')
               and b.payment_status in ('paid', 'partially_refunded')
               and p.approved_at is not null
               and b.check_in >= p.approved_at::date
               and b.check_in < (p.approved_at + make_interval(days => 30 * r.trail_months))::date
           ) as first_booking
      from partners p
      join sales_reps r on r.id = p.rep_id
     where p.rep_id = p_rep
       and (p.status <> 'deleted' or p.approved_at is not null)
  )
  select b.id, b.business_name, b.city, b.state, b.status,
         b.created_at, b.approved_at, b.first_booking,
         b.first_booking is not null,
         case when b.approved_at is null then 0
              else least(b.trail_months, floor(extract(epoch from now() - b.approved_at) / (30 * 86400))::int) end,
         coalesce(m.months, 0),
         (case when b.approved_at is not null then b.approve_bonus else 0 end) + b.monthly_bonus * coalesce(m.months, 0)
    from base b
    left join lateral (
      select count(*)::int as months
        from generate_series(1, b.trail_months) k
       where b.approved_at is not null
         and b.first_booking is not null
         and b.approved_at + make_interval(days => 30 * k) <= now()
         and public.rvnb_listed_at(b.id, b.approved_at + make_interval(days => 30 * k))
    ) m on true
   order by b.created_at desc
$$;
revoke all on function public.rvnb_rep_listings(uuid) from public, anon, authenticated;

create or replace function public.rvnb_rep_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rep sales_reps;
  v_email text;
  v_listings jsonb;
  v_payments jsonb;
  v_earned numeric;
  v_paid numeric;
begin
  if auth.uid() is null then
    return null;
  end if;

  select * into v_rep from sales_reps where user_id = auth.uid();
  if not found then
    select email into v_email from auth.users
     where id = auth.uid() and email_confirmed_at is not null;
    if v_email is null then
      return null;
    end if;
    update sales_reps set user_id = auth.uid()
     where lower(email) = lower(v_email) and user_id is null
     returning * into v_rep;
    if v_rep.id is null then
      return null;
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb), coalesce(sum(l.earned), 0)
    into v_listings, v_earned
    from rvnb_rep_listings(v_rep.id) l;

  select coalesce(jsonb_agg(jsonb_build_object('amount', amount, 'note', note, 'paid_at', paid_at) order by paid_at desc), '[]'::jsonb),
         coalesce(sum(amount), 0)
    into v_payments, v_paid
    from rep_payments where rep_id = v_rep.id;

  return jsonb_build_object(
    'name', v_rep.name,
    'code', v_rep.code,
    'active', v_rep.active,
    'approve_bonus', v_rep.approve_bonus,
    'monthly_bonus', v_rep.monthly_bonus,
    'trail_months', v_rep.trail_months,
    'listings', v_listings,
    'payments', v_payments,
    'earned', v_earned,
    'paid', v_paid,
    'owed', v_earned - v_paid
  );
end;
$$;
revoke all on function public.rvnb_rep_dashboard() from public, anon;
grant execute on function public.rvnb_rep_dashboard() to authenticated;

create function public.rvnb_admin_rep_summary()
returns table (
  rep_id uuid, name text, email text, code text, active boolean,
  approve_bonus numeric, monthly_bonus numeric, trail_months int, linked boolean,
  listings bigint, live bigint, earned numeric, paid numeric, owed numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.rvnb_is_admin() then
    raise exception 'Admin only';
  end if;
  return query
  select r.id, r.name, r.email, r.code, r.active, r.approve_bonus, r.monthly_bonus, r.trail_months,
         r.user_id is not null,
         (select count(*) from rvnb_rep_listings(r.id)),
         (select count(*) from rvnb_rep_listings(r.id) l where l.status = 'approved'),
         (select coalesce(sum(l.earned), 0) from rvnb_rep_listings(r.id) l),
         (select coalesce(sum(p.amount), 0) from rep_payments p where p.rep_id = r.id),
         (select coalesce(sum(l.earned), 0) from rvnb_rep_listings(r.id) l)
           - (select coalesce(sum(p.amount), 0) from rep_payments p where p.rep_id = r.id)
    from sales_reps r
   order by r.created_at;
end;
$$;
revoke all on function public.rvnb_admin_rep_summary() from public, anon;
grant execute on function public.rvnb_admin_rep_summary() to authenticated;
