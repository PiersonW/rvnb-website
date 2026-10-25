-- Hosts can remove their own listing (status 'deleted'), so old or test
-- listings stop cluttering the Host tab and never show on the map. Booking
-- and review history is kept: it's a soft delete, and only RVnB can restore.
--
-- Not allowed while the listing has a pending request or a confirmed stay
-- that hasn't checked out yet, so no guest is left with a booking at a spot
-- that disappeared. The host should decline or cancel those first.

create or replace function public.rvnb_listing_has_open_bookings(p_partner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from bookings
     where partner_id = p_partner
       and status in ('pending', 'confirmed')
       and check_out >= current_date
  )
$$;
revoke all on function public.rvnb_listing_has_open_bookings(uuid) from public, anon;
grant execute on function public.rvnb_listing_has_open_bookings(uuid) to authenticated;

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
    if new.status = 'deleted' and old.status <> 'deleted' then
      if public.rvnb_listing_has_open_bookings(old.id) then
        raise exception 'This listing has an upcoming stay or an open request. Decline or cancel those first, then remove it.';
      end if;
    elsif not (
      (old.status = 'approved' and new.status = 'paused')
      or (old.status = 'paused' and new.status = 'approved' and not old.paused_by_admin)
    ) then
      raise exception 'This listing status change needs an admin.';
    end if;
  end if;

  return new;
end;
$$;
