// Supabase Edge Function: delete-account
//
// Deletes the caller's RVnB account (required by App Store Review 5.1.1(v)
// for any app that lets people create one).
//
// Not a plain auth-user delete: profiles -> partners -> bookings all
// cascade, so deleting a host would also delete every booking ever made at
// their listings (other travelers' payment and payout records), and deleting
// a traveler would delete bookings hosts were paid for. Instead this:
//   1. refuses while the person has anything in flight — an upcoming trip,
//      an upcoming guest at one of their listings, or a host payout that
//      hasn't gone out yet — since cancelling those involves money moving;
//   2. detaches and scrubs their personal details from the records that
//      must be kept (bookings, listings, reviews), keeping the amounts;
//   3. deletes the auth user, which cascades their profile, messages,
//      notifications and push subscriptions.
//
// Call with { check: true } to get the blockers without deleting anything.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ADMIN_EMAIL = 'pierson.willhite@gmail.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Today's date in Utah, where all listings are.
function todayUtah() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // supabase-js never throws on a failed query; check every step so we
  // never report success with data (or the account itself) left behind.
  const step = async (label: string, promise: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await promise;
    if (error) throw new Error(`${label}: ${error.message}`);
  };

  try {
    let check = false;
    try { ({ check } = await req.json()); } catch { /* no body */ }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Identify the caller from their own JWT, never from the request body.
    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData } = await admin.auth.getUser(callerJwt);
    const user = userData?.user;
    if (!user) return json({ error: 'Please log in again.' }, 401);
    const uid = user.id;
    const email = (user.email || '').toLowerCase();
    // Guest bookings are matched by email with ilike (case-insensitive), where
    // _ and % are wildcards: escape them so a_b@x.com can't match axb@x.com.
    // Only plain addresses are used inside the PostgREST filter string.
    const emailPattern = /^[^\s,()]+@[^\s,()]+$/.test(email) ? email.replace(/[\\%_]/g, (c) => `\\${c}`) : '';

    if (email === ADMIN_EMAIL) {
      return json({ error: 'The admin account can’t be deleted from the app.' }, 400);
    }

    const today = todayUtah();

    // --- What's still in flight ---
    const { data: myListings, error: listingsErr } = await admin
      .from('partners').select('id').eq('host_id', uid);
    if (listingsErr) throw new Error(`look up listings: ${listingsErr.message}`);
    const listingIds = (myListings || []).map((l) => l.id);

    const { data: trips, error: tripsErr } = await admin
      .from('bookings')
      .select('id')
      .or(`traveler_id.eq.${uid}${emailPattern ? `,and(traveler_id.is.null,guest_email.ilike.${emailPattern})` : ''}`)
      .in('status', ['pending', 'confirmed'])
      .gte('check_out', today);
    if (tripsErr) throw new Error(`look up trips: ${tripsErr.message}`);

    let upcomingGuests = 0;
    let unpaidPayouts = 0;
    if (listingIds.length) {
      const { count: guests, error: gErr } = await admin
        .from('bookings').select('id', { count: 'exact', head: true })
        .in('partner_id', listingIds)
        .in('status', ['pending', 'confirmed'])
        .gte('check_out', today);
      if (gErr) throw new Error(`look up guests: ${gErr.message}`);
      upcomingGuests = guests || 0;

      const { count: payouts, error: pErr } = await admin
        .from('bookings').select('id', { count: 'exact', head: true })
        .in('partner_id', listingIds)
        .in('payment_status', ['paid', 'partially_refunded'])
        .in('status', ['confirmed', 'completed'])
        .or('payout_status.is.null,payout_status.in.(processing,waiting_on_host,failed)');
      if (pErr) throw new Error(`look up payouts: ${pErr.message}`);
      unpaidPayouts = payouts || 0;
    }

    const blockers: string[] = [];
    if (trips?.length) {
      blockers.push(`You have ${trips.length} upcoming trip${trips.length === 1 ? '' : 's'}. Cancel ${trips.length === 1 ? 'it' : 'them'} in Trips first.`);
    }
    if (upcomingGuests) {
      blockers.push(`You have ${upcomingGuests} upcoming guest${upcomingGuests === 1 ? '' : 's'} at your listings. Cancel those bookings from the host dashboard first.`);
    }
    if (unpaidPayouts) {
      blockers.push(`You have ${unpaidPayouts} host payout${unpaidPayouts === 1 ? '' : 's'} that haven’t gone out yet. Contact us so we can settle ${unpaidPayouts === 1 ? 'it' : 'them'} before closing your account.`);
    }

    if (check || blockers.length) {
      return json({ ok: blockers.length === 0, blockers, isHost: listingIds.length > 0 }, blockers.length && !check ? 409 : 200);
    }

    // --- Keep the records, drop the person ---
    // Their trips (as an account holder, or as a guest with the same email).
    await step('scrub trips', admin.from('bookings')
      .update({ traveler_id: null, guest_name: 'Deleted account', guest_email: null, guest_phone: null })
      .eq('traveler_id', uid));
    if (emailPattern) {
      await step('scrub guest trips', admin.from('bookings')
        .update({ guest_name: 'Deleted account', guest_email: null, guest_phone: null })
        .is('traveler_id', null)
        .ilike('guest_email', emailPattern));
    }

    // Their listings come off the map and lose their contact details, but stay
    // so past bookings (and other travelers' records of them) still resolve.
    if (listingIds.length) {
      await step('retire listings', admin.from('partners')
        .update({ host_id: null, status: 'deleted', contact_name: null, contact_email: null })
        .in('id', listingIds));
      await step('clear blocked dates', admin.from('blocked_dates').delete().in('partner_id', listingIds));
    }

    // reviews.host_id doesn't cascade and would block the profile delete.
    await step('detach reviews', admin.from('reviews').update({ host_id: null }).eq('host_id', uid));
    if (emailPattern) {
      await step('scrub reviews', admin.from('reviews').update({ traveler_email: null }).ilike('traveler_email', emailPattern));
    }

    // Cascades profile, messages they sent, notifications, push subscriptions.
    const { error: deleteErr } = await admin.auth.admin.deleteUser(uid);
    if (deleteErr) throw new Error(`delete account: ${deleteErr.message}`);

    return json({ success: true });
  } catch (err) {
    console.error('delete-account failed:', err);
    return json({ error: 'We couldn’t delete your account. Please try again, or contact us.' }, 500);
  }
});
