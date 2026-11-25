-- Free-stay listings (Pierson's decision 2026-11-25).
--
-- Why: counties (e.g. Utah County's RA-5 farm zone) treat paid, booked RV
-- stays on farmland as a commercial campground. Free one-night stays at farm
-- businesses (Harvest Hosts style) are the model counties have rules for.
--
-- A free-stay listing has no nightly price, takes 1 night per stay, is for
-- self-contained RVs only (no hookups), and its bookings skip payment. The
-- host still approves every request. How RVnB earns on free stays (a guest
-- booking fee or membership) is not decided yet; bookings.traveler_fee is
-- where a fee would go.

alter table public.partners
  add column if not exists stay_type text not null default 'paid';

alter table public.partners drop constraint if exists partners_stay_type_check;
alter table public.partners
  add constraint partners_stay_type_check check (stay_type in ('paid', 'free'));

-- Free stays have no price; paid stays still need a positive one.
alter table public.partners alter column price_per_night drop not null;
alter table public.partners drop constraint if exists price_per_night_positive;
alter table public.partners
  add constraint price_per_night_positive check (
    (stay_type = 'paid' and price_per_night > 0)
    or (stay_type = 'free' and price_per_night is null)
  );

alter table public.partners alter column spots_available set default 1;

alter table public.bookings
  add column if not exists is_free_stay boolean not null default false;
