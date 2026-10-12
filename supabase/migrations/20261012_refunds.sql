-- Track refunds on bookings.
--
-- Before this there was no refund path at all: cancelling a booking that had
-- already been charged marked it cancelled and left the traveler charged.
-- Refunds are issued by the traveler-cancel-booking and cancel-payment Edge
-- Functions (service role), which the guard trigger already allows.

alter table public.bookings
  add column if not exists refunded_amount numeric not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists cancelled_by text,
  add column if not exists refund_note text;

alter table public.bookings drop constraint if exists bookings_payment_status_check;
alter table public.bookings add constraint bookings_payment_status_check
  check (payment_status = any (array['unpaid', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled']));

alter table public.bookings drop constraint if exists bookings_cancelled_by_check;
alter table public.bookings add constraint bookings_cancelled_by_check
  check (cancelled_by is null or cancelled_by in ('traveler', 'host', 'admin'));
