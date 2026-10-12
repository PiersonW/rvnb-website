-- Host payouts.
--
-- Until now nothing ever sent hosts their share: every charge stayed in the
-- platform Stripe account. The process-payouts Edge Function now transfers
-- each finished stay's host_payout to the host's Stripe Express account,
-- and pg_cron runs it hourly. These columns record what was paid.

alter table public.bookings
  add column if not exists payout_status text,
  add column if not exists payout_amount numeric,
  add column if not exists payout_transfer_id text,
  add column if not exists paid_out_at timestamptz,
  add column if not exists payout_error text,
  add column if not exists payout_reversed_amount numeric not null default 0;

alter table public.bookings drop constraint if exists bookings_payout_status_check;
alter table public.bookings add constraint bookings_payout_status_check
  check (payout_status is null or payout_status in ('processing', 'paid', 'waiting_on_host', 'failed', 'not_owed'));

-- Everything charged before today was a test booking (the hosts are the
-- owner's own accounts). Don't pay those out.
update public.bookings
set payout_status = 'not_owed',
    payout_error = 'Completed before automatic payouts existed.'
where payment_status in ('paid', 'partially_refunded')
  and payout_status is null
  and created_at < now();

create extension if not exists pg_cron;

-- process-payouts only ever pays bookings that are due and not yet paid, so
-- running it on a schedule (or extra times) is safe.
select cron.unschedule('rvnb-process-payouts')
where exists (select 1 from cron.job where jobname = 'rvnb-process-payouts');

select cron.schedule(
  'rvnb-process-payouts',
  '7 * * * *',
  $$select net.http_post(
      url := 'https://icnhpciixqrhrqrzxkxg.supabase.co/functions/v1/process-payouts',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    )$$
);
