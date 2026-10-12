// Supabase Edge Function: create-payment-intent
//
// Prices the stay HERE, from the listing's nightly rate and the dates, and
// creates a Stripe PaymentIntent with manual capture (card held, not charged,
// until the host confirms). The browser no longer sends an amount — earlier
// versions trusted a client-supplied total, which let anyone pick their price.
//
// Everything confirm-booking needs to create the booking is stored in the
// PaymentIntent's metadata, so the booking can't be changed between the card
// hold and the database row.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep in sync with the price breakdown in listing.html.
const TRAVELER_FEE_RATE = 0.08;
const HOST_FEE_RATE = 0.12;
const TAX_RATE = 0.07;
const MAX_NIGHTS = 90;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { partnerId, checkIn, checkOut, guestName, guestEmail, guestPhone, termsAccepted } = await req.json();

    if (!partnerId || !checkIn || !checkOut) {
      return json({ error: 'Please refresh the page and try again.' }, 400);
    }
    if (!ISO_DATE.test(checkIn) || !ISO_DATE.test(checkOut)) {
      return json({ error: 'Invalid dates.' }, 400);
    }
    if (!guestName || !guestEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) {
      return json({ error: 'Please enter your name and a valid email.' }, 400);
    }
    if (termsAccepted !== true) {
      return json({ error: 'Please agree to the Terms of Service and Cancellation Policy.' }, 400);
    }

    const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
    if (!(nights >= 1 && nights <= MAX_NIGHTS)) {
      return json({ error: `Stays must be between 1 and ${MAX_NIGHTS} nights.` }, 400);
    }
    // Allow "today" in any US timezone: compare against yesterday in UTC.
    const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (checkIn < yesterdayUtc) {
      return json({ error: 'Check-in date is in the past.' }, 400);
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Logged-in traveler? (Guests without accounts call this with the anon key.)
    let travelerId = '';
    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (callerJwt) {
      const { data: userData } = await adminClient.auth.getUser(callerJwt);
      if (userData?.user) {
        travelerId = userData.user.id;
        const { data: profile } = await adminClient
          .from('profiles').select('is_paused').eq('id', travelerId).single();
        if (profile?.is_paused) {
          return json({ error: 'Your account has been paused and can\'t make new bookings. Please contact us if you believe this is a mistake.' }, 403);
        }
      }
    }

    const { data: listing } = await adminClient
      .from('partners')
      .select('id, business_name, status, price_per_night, spots_available')
      .eq('id', partnerId)
      .single();
    if (!listing || listing.status !== 'approved') {
      return json({ error: 'This listing is not currently available for booking.' }, 400);
    }
    const price = Number(listing.price_per_night);
    if (!(price > 0)) {
      return json({ error: 'This listing has no price set.' }, 400);
    }

    // Check availability before holding the card. (The bookings table trigger
    // re-checks at insert time, which covers two people racing for one spot.)
    const { count: blocked } = await adminClient
      .from('blocked_dates')
      .select('id', { count: 'exact', head: true })
      .eq('partner_id', partnerId)
      .lt('start_date', checkOut)
      .gt('end_date', checkIn);
    if (blocked && blocked > 0) {
      return json({ error: 'The host has blocked those dates. Please choose different dates.' }, 409);
    }
    const { count: overlapping } = await adminClient
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('partner_id', partnerId)
      .neq('status', 'cancelled')
      .lt('check_in', checkOut)
      .gt('check_out', checkIn);
    if ((overlapping ?? 0) >= (listing.spots_available ?? 1)) {
      return json({ error: 'This listing is fully booked for those dates. Please choose different dates.' }, 409);
    }

    // Same formulas as listing.html's price breakdown.
    const subtotal = nights * price;
    const travelerFee = subtotal * TRAVELER_FEE_RATE;
    const taxAmount = (subtotal + travelerFee) * TAX_RATE;
    const totalCharged = subtotal + travelerFee + taxAmount;
    const hostFee = subtotal * HOST_FEE_RATE;
    const hostPayout = subtotal - hostFee;
    const amountCents = Math.round(totalCharged * 100);

    const params = new URLSearchParams();
    params.append('amount', String(amountCents));
    params.append('currency', 'usd');
    params.append('capture_method', 'manual');
    params.append('automatic_payment_methods[enabled]', 'true');
    params.append('receipt_email', guestEmail);
    params.append('description', `${listing.business_name}: ${checkIn} to ${checkOut}`);
    const meta: Record<string, string> = {
      rvnb_booking: '1',
      listing_name: String(listing.business_name).slice(0, 450),
      partner_id: listing.id,
      check_in: checkIn,
      check_out: checkOut,
      nights: String(nights),
      price_per_night: String(price),
      amount_cents: String(amountCents),
      traveler_id: travelerId,
      guest_name: String(guestName).trim().slice(0, 200),
      guest_email: String(guestEmail).trim().slice(0, 200),
      guest_phone: String(guestPhone || '').trim().slice(0, 50),
      terms_accepted_at: new Date().toISOString(),
    };
    for (const [k, v] of Object.entries(meta)) params.append(`metadata[${k}]`, v);

    const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      return json({ error: data.error?.message || 'Stripe error creating payment' }, 400);
    }

    return json({
      clientSecret: data.client_secret,
      paymentIntentId: data.id,
      pricing: { nights, subtotal, travelerFee, taxAmount, totalCharged, hostFee, hostPayout },
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
