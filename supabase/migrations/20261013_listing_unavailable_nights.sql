-- Nights a listing can't be booked, for date pickers.
--
-- Travelers can only read their own bookings under RLS, so a client can't
-- see which nights other people have taken (listing.html's loadBookedDates
-- always came back empty for them; only the server-side check caught
-- conflicts). This returns just the dates — no guests, no amounts — for an
-- approved listing: nights the host blocked, plus nights where non-cancelled
-- bookings already fill every spot. Same rules as check_spot_availability:
-- a stay covers [check_in, check_out), a block covers [start_date, end_date).

create or replace function public.listing_unavailable_nights(p_partner_id uuid)
returns table (night date)
language sql
stable
security definer
set search_path = public
as $$
  with listing as (
    select coalesce(spots_available, 1) as spots
    from partners
    where id = p_partner_id and status = 'approved'
  ),
  nights as (
    select generate_series(current_date - 1, current_date + 365, interval '1 day')::date as night
  )
  select n.night
  from nights n
  cross join listing l
  where exists (
      select 1 from blocked_dates b
      where b.partner_id = p_partner_id
        and n.night >= b.start_date and n.night < b.end_date
    )
    or (
      select count(*) from bookings k
      where k.partner_id = p_partner_id
        and k.status <> 'cancelled'
        and n.night >= k.check_in and n.night < k.check_out
    ) >= l.spots
  order by n.night
$$;

revoke all on function public.listing_unavailable_nights(uuid) from public;
grant execute on function public.listing_unavailable_nights(uuid) to anon, authenticated;
