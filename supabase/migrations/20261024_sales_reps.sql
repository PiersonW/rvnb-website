-- Sales reps: people who go out and sign businesses up to host on RVnB.
--
-- Each rep has a short referral code. A listing submitted with that code
-- (typed in, or prefilled from the rep's link / QR code) is credited to the
-- rep. Reps earn a flat amount when the listing is approved and a bonus after
-- its first completed stay; the admin pays them outside RVnB and records each
-- payment here so the rep dashboard can show what's still owed.
--
-- Reps never see owners' contact details: their dashboard reads everything
-- through rvnb_rep_dashboard(), which returns only listing name, place and
-- status. Only the admin can add reps, change rates, or re-credit a listing.

create table if not exists public.sales_reps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text not null,
  code text not null,
  active boolean not null default true,
  approve_bonus numeric(10,2) not null default 10,
  first_stay_bonus numeric(10,2) not null default 15,
  created_at timestamptz not null default now()
);
create unique index if not exists sales_reps_code_unique on public.sales_reps (upper(code));
create unique index if not exists sales_reps_email_unique on public.sales_reps (lower(email));

create table if not exists public.rep_payments (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references public.sales_reps(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  note text,
  paid_at timestamptz not null default now()
);
create index if not exists rep_payments_rep_id_idx on public.rep_payments (rep_id);

alter table public.partners add column if not exists referral_code text;
alter table public.partners add column if not exists rep_id uuid references public.sales_reps(id) on delete set null;
alter table public.partners add column if not exists approved_at timestamptz;
create index if not exists partners_rep_id_idx on public.partners (rep_id);

-- Listings already live count as approved from when they were created.
update public.partners set approved_at = created_at
 where approved_at is null and status in ('approved', 'paused');

alter table public.sales_reps enable row level security;
alter table public.rep_payments enable row level security;

drop policy if exists "Admin manages sales reps" on public.sales_reps;
create policy "Admin manages sales reps" on public.sales_reps
  for all using (public.rvnb_is_privileged()) with check (public.rvnb_is_privileged());

drop policy if exists "Admin manages rep payments" on public.rep_payments;
create policy "Admin manages rep payments" on public.rep_payments
  for all using (public.rvnb_is_privileged()) with check (public.rvnb_is_privileged());

grant select, insert, update, delete on public.sales_reps to authenticated;
grant select, insert, update, delete on public.rep_payments to authenticated;
grant all on public.sales_reps to service_role;
grant all on public.rep_payments to service_role;

-- Note: rvnb_is_privileged() is true inside any SECURITY DEFINER function
-- (current_user is postgres there), so admin checks below either run in
-- invoker functions or test the admin's JWT directly via rvnb_is_admin().
create or replace function public.rvnb_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or coalesce(auth.jwt() ->> 'email', '') = 'pierson.willhite@gmail.com'
$$;

-- The active rep for a code, without exposing the reps table.
create or replace function public.rvnb_rep_for_code(p_code text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from sales_reps where upper(code) = upper(trim(p_code)) and active limit 1
$$;
grant execute on function public.rvnb_rep_for_code(text) to anon, authenticated;

-- Credits a listing to the rep whose code it was submitted with, and stamps
-- the first approval. Hosts can add a code to their own listing while it's
-- still in review and uncredited (e.g. they forgot at sign-up); after that,
-- only the admin can move the credit. Runs as the caller (not SECURITY
-- DEFINER) so rvnb_is_privileged() means what it says.
create or replace function public.rvnb_partner_referral()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'approved' and new.approved_at is null then
    new.approved_at := now();
  end if;

  if tg_op = 'UPDATE' and not public.rvnb_is_privileged() then
    if new.rep_id is distinct from old.rep_id then
      raise exception 'Only RVnB can change who signed up a listing.';
    end if;
    if new.referral_code is distinct from old.referral_code
       and (old.rep_id is not null or old.status not in ('pending', 'waitlist')) then
      new.referral_code := old.referral_code;
    end if;
  end if;

  if tg_op = 'INSERT' and not public.rvnb_is_privileged() then
    new.rep_id := null;
  end if;

  new.referral_code := nullif(upper(trim(coalesce(new.referral_code, ''))), '');
  if new.rep_id is null and new.referral_code is not null then
    new.rep_id := public.rvnb_rep_for_code(new.referral_code);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_partner_referral on public.partners;
create trigger trg_partner_referral
  before insert or update on public.partners
  for each row execute function public.rvnb_partner_referral();

-- Lets the sign-up form say "Signed up with Jake" before submitting, without
-- exposing the reps table. Returns the rep's first name or null.
create or replace function public.rvnb_check_referral_code(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select split_part(name, ' ', 1) from sales_reps
   where upper(code) = upper(trim(p_code)) and active
   limit 1
$$;
grant execute on function public.rvnb_check_referral_code(text) to anon, authenticated;

-- Earnings per credited listing: approve_bonus once approved, plus
-- first_stay_bonus once it has a completed, not fully refunded stay.
create or replace function public.rvnb_rep_listings(p_rep uuid)
returns table (
  listing_id uuid, business_name text, city text, state text, status text,
  submitted_at timestamptz, approved_at timestamptz, first_stay_at date,
  completed_stays bigint, earned numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.business_name, p.city, p.state, p.status,
         p.created_at, p.approved_at, s.first_stay, coalesce(s.stays, 0),
         (case when p.approved_at is not null then r.approve_bonus else 0 end)
       + (case when s.first_stay is not null then r.first_stay_bonus else 0 end)
    from partners p
    join sales_reps r on r.id = p.rep_id
    left join lateral (
      select min(b.check_out) as first_stay, count(*) as stays
        from bookings b
       where b.partner_id = p.id and b.status = 'completed'
         and b.payment_status in ('paid', 'partially_refunded')
    ) s on true
   where p.rep_id = p_rep and p.status <> 'deleted'
   order by p.created_at desc
$$;
revoke all on function public.rvnb_rep_listings(uuid) from public, anon, authenticated;

-- The signed-in rep's dashboard. Links the account to the rep record the
-- first time, by confirmed email. Returns null for anyone who isn't a rep.
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
    'first_stay_bonus', v_rep.first_stay_bonus,
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

-- Admin overview of every rep: listings credited, earned, paid, owed.
create or replace function public.rvnb_admin_rep_summary()
returns table (
  rep_id uuid, name text, email text, code text, active boolean,
  approve_bonus numeric, first_stay_bonus numeric, linked boolean,
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
  select r.id, r.name, r.email, r.code, r.active, r.approve_bonus, r.first_stay_bonus,
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
