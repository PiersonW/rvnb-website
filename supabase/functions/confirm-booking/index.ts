// Supabase Edge Function: confirm-booking
//
// Called by listing.html after Stripe has authorized (held) the traveler's
// card. Creates the booking row from the PaymentIntent created by
// create-payment-intent, never from browser-supplied values: the dates,
// listing, guest and price all come from the PaymentIntent's metadata, and
// the held amount must match what that metadata says was charged.
//
// Also sends the "request received" email to the guest and the "new request"
// email to the host, which used to go out from the browser.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep in sync with create-payment-intent and listing.html.
const TRAVELER_FEE_RATE = 0.08;
const HOST_FEE_RATE = 0.12;
const TAX_RATE = 0.07;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

async function stripe(path: string, key: string, method = 'GET') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { 'Authorization': `Bearer ${key}` },
  });
  return { ok: res.ok, data: await res.json() };
}

async function sendEmail(resendKey: string | undefined, to: string, subject: string, html: string) {
  if (!resendKey || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'RVnB <notifications@tryrvnb.com>',
      to: [to],
      reply_to: 'hello@hivebuilt.dev',
      subject,
      html,
    }),
  }).catch(() => {});
}

type RequestInfo = {
  bookingId: string; partnerId: string; listingName: string;
  guestName: string; guestEmail: string; checkIn: string; checkOut: string;
  totalCharged: number; isFree: boolean;
};

// "Request received" to the guest and "new request" to the host.
async function sendRequestEmails(adminClient: any, resendKey: string | undefined, r: RequestInfo) {
  const { data: listing } = await adminClient
    .from('partners')
    .select('business_name, address, city, state, host_id')
    .eq('id', r.partnerId)
    .single();
  const spot = esc(listing?.business_name || r.listingName);
  const dates = `${formatDate(r.checkIn)} → ${formatDate(r.checkOut)}`;
  const cancelLink = `https://tryrvnb.com/cancel-booking.html?booking=${r.bookingId}`;

  const guestEmail = sendEmail(resendKey, r.guestEmail,
    `Request received — ${listing?.business_name || r.listingName}`,
    `
      <p>Hi ${esc(r.guestName)},</p>
      <p>We got your ${r.isFree ? 'free stay ' : 'booking '}request. The host will confirm shortly — you'll get another email the moment they do.</p>
      <table style="border-collapse:collapse; margin:14px 0;">
        <tr><td style="padding:4px 12px 4px 0; color:#555;">Location</td><td><b>${spot}</b></td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#555;">Address</td><td>${esc(`${listing?.address}, ${listing?.city}, ${listing?.state}`)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#555;">Dates</td><td>${dates}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#555;">Total</td><td>${r.isFree ? 'Free' : `$${r.totalCharged.toFixed(2)}`}</td></tr>
      </table>
      ${r.isFree
        ? `<p>This is a free stay for self-contained RVs (no hookups). If you can, support the host by buying something while you're there.</p>`
        : `<p>Your card is held, not charged, until the host accepts.</p>`}
      <p>Need to cancel? <a href="${cancelLink}">Cancel this trip</a> — no account needed.</p>
    `);

  let hostEmail: Promise<void> = Promise.resolve();
  if (listing?.host_id) {
    const { data: hostProfile } = await adminClient
      .from('profiles').select('email').eq('id', listing.host_id).single();
    if (hostProfile?.email) {
      hostEmail = sendEmail(resendKey, hostProfile.email,
        `New ${r.isFree ? 'free stay' : 'booking'} request — ${listing.business_name}`,
        `<p>Hi,</p><p>You have a new ${r.isFree ? 'free stay ' : 'booking '}request from <b>${esc(r.guestName)}</b> for ${dates}.</p><p>Log into your <a href="https://tryrvnb.com/host-dashboard.html">host dashboard</a> to confirm or decline.</p>`);
    }
  }
  await Promise.all([guestEmail, hostEmail]);
}

// FREE STAY — no payment. One night, self-contained RVs, host still approves.
// RVnB's fee for free stays isn't decided yet (guest booking fee or
// membership). When it is, charge it here (and set traveler_fee), never
// anything to the host.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
async function requestFreeStay(req: Request, body: any, adminClient: any, resendKey: string | undefined) {
  const { partnerId, checkIn, checkOut, guestName, guestEmail, guestPhone, termsAccepted } = body;
  if (!partnerId || !ISO_DATE.test(checkIn || '') || !ISO_DATE.test(checkOut || '')) {
    return json({ error: 'Please refresh the page and try again.' }, 400);
  }
  if (!guestName || !guestEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) {
    return json({ error: 'Please enter your name and a valid email.' }, 400);
  }
  if (termsAccepted !== true) {
    return json({ error: 'Please agree to the Terms of Service and Cancellation Policy.' }, 400);
  }
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
  if (nights !== 1) {
    return json({ error: 'Free stays are one night. Pick a check-out date the day after check-in.' }, 400);
  }
  const yesterdayUtc = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (checkIn < yesterdayUtc) return json({ error: 'Check-in date is in the past.' }, 400);

  let travelerId: string | null = null;
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
    .from('partners').select('id, business_name, status, stay_type').eq('id', partnerId).single();
  if (!listing || listing.status !== 'approved') {
    return json({ error: 'This listing is not currently available for booking.' }, 400);
  }
  if (listing.stay_type !== 'free') {
    return json({ error: 'This listing is a paid stay. Please refresh the page and try again.' }, 400);
  }

  // The bookings trigger checks spots and blocked dates at insert time.
  const { data: booking, error } = await adminClient
    .from('bookings')
    .insert({
      partner_id: listing.id,
      check_in: checkIn,
      check_out: checkOut,
      subtotal: 0, traveler_fee: 0, tax_amount: 0, total_charged: 0,
      host_fee: 0, host_payout: 0, tax_rate: 0, total_price: 0,
      guest_name: String(guestName).trim().slice(0, 200),
      guest_email: String(guestEmail).trim().slice(0, 200),
      guest_phone: String(guestPhone || '').trim().slice(0, 50) || null,
      traveler_id: travelerId,
      payment_intent_id: null,
      status: 'pending',
      payment_status: 'unpaid',
      payout_status: 'not_owed',
      is_free_stay: true,
      terms_accepted_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) {
    const msg = error.message || '';
    const reason = msg.includes('fully booked') ? 'fully_booked' : msg.includes('blocked') ? 'blocked' : 'error';
    return json({ error: msg || 'Could not save your request', reason }, 409);
  }

  await sendRequestEmails(adminClient, resendKey, {
    bookingId: booking.id, partnerId: listing.id, listingName: listing.business_name,
    guestName, guestEmail, checkIn, checkOut, totalCharged: 0, isFree: true,
  });
  return json({ success: true, bookingId: booking.id, free: true });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { paymentIntentId } = body;
    if (!body.freeStay && (!paymentIntentId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId))) {
      return json({ error: 'paymentIntentId is required' }, 400);
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (body.freeStay) {
      return await requestFreeStay(req, body, adminClient, RESEND_API_KEY);
    }

    // Already turned into a booking (e.g. the browser retried)? Return it.
    const { data: existing } = await adminClient
      .from('bookings').select('id').eq('payment_intent_id', paymentIntentId).maybeSingle();
    if (existing) return json({ success: true, bookingId: existing.id });

    const { ok, data: pi } = await stripe(`payment_intents/${paymentIntentId}`, STRIPE_SECRET_KEY);
    if (!ok) return json({ error: pi.error?.message || 'Could not find that payment' }, 400);

    const m = pi.metadata || {};
    if (m.rvnb_booking !== '1') {
      return json({ error: 'This payment was not created for a booking.' }, 400);
    }
    if (pi.status !== 'requires_capture') {
      return json({ error: 'Your card has not been authorized yet.' }, 400);
    }
    if (pi.currency !== 'usd' || String(pi.amount) !== m.amount_cents) {
      // Shouldn't be possible (we set both), but never record a booking whose
      // hold doesn't match its price.
      await stripe(`payment_intents/${paymentIntentId}/cancel`, STRIPE_SECRET_KEY, 'POST');
      return json({ error: 'Payment amount mismatch. Your card hold has been released.' }, 400);
    }

    const nights = Number(m.nights);
    const price = Number(m.price_per_night);
    const subtotal = nights * price;
    const travelerFee = subtotal * TRAVELER_FEE_RATE;
    const taxAmount = (subtotal + travelerFee) * TAX_RATE;
    const totalCharged = subtotal + travelerFee + taxAmount;
    const hostFee = subtotal * HOST_FEE_RATE;
    const hostPayout = subtotal - hostFee;

    const { data: booking, error } = await adminClient
      .from('bookings')
      .insert({
        partner_id: m.partner_id,
        check_in: m.check_in,
        check_out: m.check_out,
        subtotal,
        traveler_fee: travelerFee,
        tax_amount: taxAmount,
        total_charged: totalCharged,
        host_fee: hostFee,
        host_payout: hostPayout,
        tax_rate: TAX_RATE,
        total_price: totalCharged, // kept for backward compatibility
        guest_name: m.guest_name,
        guest_email: m.guest_email,
        guest_phone: m.guest_phone || null,
        traveler_id: m.traveler_id || null,
        payment_intent_id: paymentIntentId,
        status: 'pending',
        payment_status: 'authorized',
        terms_accepted_at: m.terms_accepted_at || new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      // Lost a race for the same PaymentIntent — the other request made the booking.
      if (error.code === '23505') {
        const { data: again } = await adminClient
          .from('bookings').select('id').eq('payment_intent_id', paymentIntentId).maybeSingle();
        if (again) return json({ success: true, bookingId: again.id });
      }
      // Dates got taken (or blocked) between the hold and now: release the hold
      // right away instead of leaving it on the traveler's card for days.
      await stripe(`payment_intents/${paymentIntentId}/cancel`, STRIPE_SECRET_KEY, 'POST');
      const msg = error.message || '';
      const reason = msg.includes('fully booked') ? 'fully_booked'
        : msg.includes('blocked') ? 'blocked'
        : 'error';
      return json({ error: msg || 'Could not save your booking', reason, holdReleased: true }, 409);
    }

    // Emails — best effort; the booking is already saved.
    await sendRequestEmails(adminClient, RESEND_API_KEY, {
      bookingId: booking.id, partnerId: m.partner_id, listingName: m.listing_name,
      guestName: m.guest_name, guestEmail: m.guest_email,
      checkIn: m.check_in, checkOut: m.check_out, totalCharged, isFree: false,
    });

    return json({
      success: true,
      bookingId: booking.id,
      pricing: { nights, subtotal, travelerFee, taxAmount, totalCharged, hostFee, hostPayout },
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
