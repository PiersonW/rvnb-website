-- Links bookings made as a guest (on the website, before signing in) to the
-- account with the same email. Emails are compared case-insensitively because
-- people type "Name@Gmail.com" at checkout but sign in as "name@gmail.com".
-- Only for accounts whose email is confirmed, so nobody can claim someone
-- else's bookings by signing up with their address.
create or replace function public.rvnb_claim_guest_bookings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select email into v_email from auth.users
   where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;

  update public.bookings
     set traveler_id = auth.uid()
   where traveler_id is null
     and lower(trim(guest_email)) = lower(v_email);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.rvnb_claim_guest_bookings() from public, anon;
grant execute on function public.rvnb_claim_guest_bookings() to authenticated;
