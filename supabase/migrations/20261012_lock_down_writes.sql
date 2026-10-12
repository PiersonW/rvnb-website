-- Lock down what browsers can write directly.
--
-- Before this, RLS let travelers/hosts/anonymous visitors write any column on
-- rows they could touch: set their own booking price or status, approve their
-- own listing, flip their Stripe flags, post reviews on any listing, or edit
-- the other person's messages. Row-level policies can't restrict *columns*, so
-- these BEFORE triggers do: anything not explicitly allowed below must come
-- from an Edge Function (service role), a SECURITY DEFINER trigger, or the admin.

-- Who may write anything: Edge Functions (service role), DB-owned trigger
-- functions (run as postgres), and the admin account (same check as the
-- existing admin policies).
create or replace function public.rvnb_is_privileged()
returns boolean
language sql
stable
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or current_user in ('postgres', 'supabase_admin')
      or coalesce(auth.jwt() ->> 'email', '') = 'pierson.willhite@gmail.com'
$$;

-- ---------------------------------------------------------------------------
-- bookings: created only by the confirm-booking Edge Function now, which
-- prices the stay server-side and checks the Stripe hold matches.
-- ---------------------------------------------------------------------------
drop policy if exists "Anyone can insert a booking" on public.bookings;
drop policy if exists "Anyone can request a booking" on public.bookings;
drop policy if exists "Travelers can create bookings" on public.bookings;

create or replace function public.rvnb_guard_booking_update()
returns trigger
language plpgsql
as $$
declare
  v_host_id uuid;
begin
  if public.rvnb_is_privileged() then
    return new;
  end if;

  -- A traveler claiming their own earlier guest booking (traveler-login.html):
  -- only traveler_id may change, and only from null to themselves.
  if old.traveler_id is null
     and new.traveler_id = auth.uid()
     and (to_jsonb(new) - 'traveler_id') = (to_jsonb(old) - 'traveler_id') then
    return new;
  end if;

  -- The host marking a finished stay completed (host-dashboard.html).
  select host_id into v_host_id from public.partners where id = old.partner_id;
  if v_host_id = auth.uid()
     and old.status = 'confirmed'
     and new.status = 'completed'
     and old.check_out <= current_date
     and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
    return new;
  end if;

  raise exception 'This change to a booking is not allowed.';
end;
$$;

drop trigger if exists trg_guard_booking_update on public.bookings;
create trigger trg_guard_booking_update
  before update on public.bookings
  for each row execute function public.rvnb_guard_booking_update();

-- ---------------------------------------------------------------------------
-- partners (listings): hosts edit their own details, but approval is the
-- admin's call. Hosts may only pause/unpause a listing that's already live,
-- and never one the admin paused.
-- ---------------------------------------------------------------------------
create or replace function public.rvnb_guard_partner_write()
returns trigger
language plpgsql
as $$
begin
  if public.rvnb_is_privileged() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'waitlist') then
      raise exception 'New listings must be submitted for review.';
    end if;
    new.paused_by_admin := false;
    return new;
  end if;

  if new.host_id is distinct from old.host_id
     or new.paused_by_admin is distinct from old.paused_by_admin then
    raise exception 'This change to a listing is not allowed.';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'approved' and new.status = 'paused')
      or (old.status = 'paused' and new.status = 'approved' and not old.paused_by_admin)
    ) then
      raise exception 'This listing status change needs an admin.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_partner_write on public.partners;
create trigger trg_guard_partner_write
  before insert or update on public.partners
  for each row execute function public.rvnb_guard_partner_write();

-- ---------------------------------------------------------------------------
-- profiles: users edit their name/phone/address and pick host vs traveler.
-- Stripe status and account pausing are set by Edge Functions / the admin.
-- ---------------------------------------------------------------------------
create or replace function public.rvnb_guard_profile_write()
returns trigger
language plpgsql
as $$
begin
  if public.rvnb_is_privileged() then
    return new;
  end if;

  if new.role is not null and new.role not in ('host', 'traveler') then
    raise exception 'Invalid role.';
  end if;

  if tg_op = 'INSERT' then
    new.stripe_account_id := null;
    new.stripe_charges_enabled := false;
    new.stripe_payouts_enabled := false;
    new.is_paused := false;
    return new;
  end if;

  if new.stripe_account_id is distinct from old.stripe_account_id
     or new.stripe_charges_enabled is distinct from old.stripe_charges_enabled
     or new.stripe_payouts_enabled is distinct from old.stripe_payouts_enabled
     or new.is_paused is distinct from old.is_paused
     or (new.email is distinct from old.email
         and new.email is distinct from (auth.jwt() ->> 'email')) then
    raise exception 'This change to a profile is not allowed.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_profile_write on public.profiles;
create trigger trg_guard_profile_write
  before insert or update on public.profiles
  for each row execute function public.rvnb_guard_profile_write();

-- ---------------------------------------------------------------------------
-- messages: the "mark read" policy let either side rewrite message text.
-- ---------------------------------------------------------------------------
create or replace function public.rvnb_guard_message_update()
returns trigger
language plpgsql
as $$
begin
  if public.rvnb_is_privileged() then
    return new;
  end if;
  if (to_jsonb(new) - 'read_at') <> (to_jsonb(old) - 'read_at') then
    raise exception 'Messages can only be marked read.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_message_update on public.messages;
create trigger trg_guard_message_update
  before update on public.messages
  for each row execute function public.rvnb_guard_message_update();

-- ---------------------------------------------------------------------------
-- reviews: must belong to a real completed booking, match that booking's
-- listing/host/guest, and only one per side per booking. Review links are
-- emailed and work without logging in (the booking id is the access token),
-- so this checks the booking rather than who's logged in. SECURITY DEFINER
-- because anonymous reviewers can't read bookings under RLS.
-- ---------------------------------------------------------------------------
create or replace function public.rvnb_review_allowed(
  p_booking_id uuid,
  p_reviewer_type text,
  p_partner_id uuid,
  p_host_id uuid,
  p_traveler_email text
)
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
    where b.id = p_booking_id
      and b.status = 'completed'
      and (
        (p_reviewer_type = 'traveler'
          and p_partner_id = b.partner_id
          and p_host_id = p.host_id)
        or
        (p_reviewer_type = 'host'
          and p_partner_id is null
          and p_host_id is null
          and p_traveler_email is not distinct from b.guest_email)
      )
  )
$$;

drop policy if exists "Anyone can submit a review" on public.reviews;
create policy "Reviews must match a completed booking"
  on public.reviews for insert
  with check (public.rvnb_review_allowed(booking_id, reviewer_type, partner_id, host_id, traveler_email));

create unique index if not exists reviews_one_per_side_per_booking
  on public.reviews (booking_id, reviewer_type);

-- Bookings created by confirm-booking are keyed by their Stripe hold, so a
-- retried request can't create the same booking twice.
create unique index if not exists bookings_payment_intent_unique
  on public.bookings (payment_intent_id)
  where payment_intent_id is not null;
