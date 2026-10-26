-- A rep's earnings don't disappear when a host later removes the listing.
-- rvnb_rep_listings used to skip every 'deleted' listing, so a lot that had
-- gone live (and earned the rep their approve bonus, maybe already paid out)
-- dropped off and the rep showed as overpaid. Now a removed listing still
-- counts if it was ever approved; one removed before approval still doesn't.

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
   where p.rep_id = p_rep
     and (p.status <> 'deleted' or p.approved_at is not null)
   order by p.created_at desc
$$;
revoke all on function public.rvnb_rep_listings(uuid) from public, anon, authenticated;
