-- New-message notifications, now also for travelers who booked as a guest.
--
-- notify_new_message used to drop a host's message silently when the booking
-- had no traveler account (traveler_id null): there was nobody to notify. It
-- now asks send-push to email the guest instead, with a link to sign in and
-- reply.
--
-- rvnb_send_push_secret() returns the x-push-secret that trigger_push_notification
-- already sends. It was created directly in the database so the secret stays
-- out of git; execute is revoked from every client role.

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_traveler_id uuid;
  v_host_id uuid;
  v_business_name text;
  v_guest_email text;
  v_recipient_id uuid;
  v_link text;
  v_preview text;
begin
  select b.traveler_id, p.host_id, p.business_name, b.guest_email
  into v_traveler_id, v_host_id, v_business_name, v_guest_email
  from bookings b
  join partners p on p.id = b.partner_id
  where b.id = new.booking_id;

  v_preview := left(new.body, 120);

  if new.sender_id = v_traveler_id then
    v_recipient_id := v_host_id;
    v_link := 'host-dashboard.html?thread=' || new.booking_id;
  elsif new.sender_id = v_host_id then
    v_recipient_id := v_traveler_id;
    v_link := 'traveler-dashboard.html?thread=' || new.booking_id;

    -- Guest booking with no account yet: email them instead.
    if v_traveler_id is null and v_guest_email is not null then
      perform net.http_post(
        url := 'https://icnhpciixqrhrqrzxkxg.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-push-secret', public.rvnb_send_push_secret()
        ),
        body := jsonb_build_object(
          'guest_booking_id', new.booking_id,
          'message', new.body
        )
      );
      return new;
    end if;
  end if;

  if v_recipient_id is null then
    return new;
  end if;

  insert into notifications (user_id, type, title, message, link)
  values (
    v_recipient_id,
    'new_message',
    'New message about ' || coalesce(v_business_name, 'your booking'),
    v_preview,
    v_link
  );

  return new;
end;
$$;
