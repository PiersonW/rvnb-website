// Supabase Edge Function: traveler-cancel-booking
//
// Handles a traveler or guest cancelling their own trip. Works two ways:
//   - Logged-in traveler: must be authenticated AND be the traveler_id on the booking
//   - Guest (no account): the booking_id itself acts as the access token — same
//     trust model as the review links — but ONLY works if the booking was never
//     claimed by a real account (traveler_id is still null)
//
// Applies the cancellation policy (cancellation-policy.html):
//   - Request not yet confirmed (card only held): release the hold, no charge.
//   - Confirmed and charged, more than 24h before check-in: full refund.
//   - Confirmed and charged, within 24h of check-in: cancelled, no refund.
// "Check-in" is the check-in date at the listing's arrival time, Utah time.
//
// Call with { bookingId, confirm: false } to preview what would happen
// (including the refund amount) without changing anything.
//
// IMPORTANT: "Enforce JWT verification" stays OFF for this function — guests
// without accounts need to be able to call it with no login at all.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const REFUND_CUTOFF_HOURS = 24;
const LISTING_TIMEZONE = 'America/Denver'; // all listings are in Utah for now

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

// UTC milliseconds for a wall-clock date + "HH:MM" in the listing's timezone.
function localToUtcMs(date: string, time: string, timeZone: string) {
  const naive = Date.parse(`${date}T${(time || '00:00').slice(0, 5)}:00Z`);
  const offsetMinutes = (ts: number) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ts)).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  };
  // Two passes so the offset is the one in effect at the resulting instant (DST edges).
  let utc = naive - offsetMinutes(naive) * 60000;
  utc = naive - offsetMinutes(utc) * 60000;
  return utc;
}

const toCents = (n: unknown) => Math.round(Number(n || 0) * 100);

async function stripePost(path: string, key: string, params?: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST', headers, body: params?.toString(),
  });
  return { ok: res.ok, data: await res.json() };
}

async function sendEmail(resendKey: string | undefined, to: string | null | undefined, subject: string, html: string) {
  if (!resendKey || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'RVnB <notifications@tryrvnb.com>',
      to: [to],
      reply_to: 'pierson.willhite@gmail.com',
      subject,
      html,
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { bookingId, confirm } = await req.json();
    if (!bookingId) throw new Error('bookingId is required');

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: booking, error: bookingErr } = await adminClient
      .from('bookings')
      .select('*, partners(business_name, host_id, arrival_time)')
      .eq('id', bookingId)
      .single();

    if (bookingErr || !booking) return json({ error: 'Booking not found' }, 404);

    // Authorization check
    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    let authorized = false;
    if (booking.traveler_id) {
      // This booking belongs to a real account — only that logged-in traveler can cancel it
      if (callerJwt) {
        const { data: userData } = await adminClient.auth.getUser(callerJwt);
        if (userData?.user && userData.user.id === booking.traveler_id) authorized = true;
      }
    } else {
      // Pure guest booking, never claimed — the booking ID itself is the access token
      authorized = true;
    }
    if (!authorized) return json({ error: 'Not authorized to cancel this booking' }, 403);

    if (booking.status === 'cancelled') {
      return json({ success: true, alreadyCancelled: true });
    }
    if (booking.status === 'completed') {
      return json({ error: 'This trip has already been completed and cannot be cancelled' }, 400);
    }

    // Work out what cancelling means for this booking right now.
    const remainingCents = toCents(booking.total_charged ?? booking.total_price) - toCents(booking.refunded_amount);
    const checkInMs = localToUtcMs(booking.check_in, booking.partners?.arrival_time || '00:00', LISTING_TIMEZONE);
    const hoursUntilCheckIn = (checkInMs - Date.now()) / 3600000;

    let plan: 'release' | 'refund' | 'no_refund' | 'none';
    if (booking.payment_intent_id && booking.payment_status === 'authorized') plan = 'release';
    else if (['paid', 'partially_refunded'].includes(booking.payment_status) && remainingCents > 0) {
      plan = hoursUntilCheckIn > REFUND_CUTOFF_HOURS ? 'refund' : 'no_refund';
    } else plan = 'none';

    const refundCents = plan === 'refund' ? remainingCents : 0;
    const outcome = {
      plan,
      refundAmount: refundCents / 100,
      message:
        plan === 'release' ? 'Your card hold will be released. You won\'t be charged.'
        : plan === 'refund' ? `You'll get a full refund of $${(refundCents / 100).toFixed(2)} to your original payment method.`
        : plan === 'no_refund' ? `It's less than ${REFUND_CUTOFF_HOURS} hours before check-in, so this booking is no longer refundable under the cancellation policy.`
        : 'You haven\'t been charged for this trip.',
    };

    // Preview mode — return safe details for display without cancelling anything yet
    if (confirm === false) {
      return json({
        success: true,
        preview: true,
        outcome,
        booking: {
          guest_name: booking.guest_name,
          check_in: booking.check_in,
          check_out: booking.check_out,
          status: booking.status,
          total_charged: booking.total_charged,
          business_name: booking.partners?.business_name,
        },
      });
    }

    let paymentStatus = booking.payment_status;
    if (plan === 'release') {
      const { ok, data } = await stripePost(`payment_intents/${booking.payment_intent_id}/cancel`, STRIPE_SECRET_KEY);
      if (!ok && data.error?.code !== 'payment_intent_unexpected_state') {
        return json({ error: data.error?.message || 'Stripe cancel failed' }, 400);
      }
      paymentStatus = 'cancelled';
    } else if (plan === 'refund') {
      const params = new URLSearchParams();
      params.append('payment_intent', booking.payment_intent_id);
      params.append('amount', String(refundCents));
      params.append('reason', 'requested_by_customer');
      params.append('metadata[booking_id]', booking.id);
      params.append('metadata[refunded_by]', 'traveler');
      const { ok, data } = await stripePost('refunds', STRIPE_SECRET_KEY, params,
        `rvnb-refund-${booking.id}-${toCents(booking.refunded_amount)}-${refundCents}`);
      if (!ok) return json({ error: data.error?.message || 'Stripe refund failed' }, 400);
      paymentStatus = 'refunded';
    }

    const refundedTotal = (toCents(booking.refunded_amount) + refundCents) / 100;
    await adminClient
      .from('bookings')
      .update({
        status: 'cancelled',
        payment_status: paymentStatus,
        cancelled_by: 'traveler',
        ...(refundCents > 0 ? { refunded_amount: refundedTotal, refunded_at: new Date().toISOString() } : {}),
      })
      .eq('id', bookingId);

    const spot = esc(booking.partners?.business_name || 'your listing');
    const dates = `${booking.check_in} → ${booking.check_out}`;

    // Confirm to the traveler, with what happened to their money
    await sendEmail(RESEND_API_KEY, booking.guest_email, `Trip cancelled — ${booking.partners?.business_name || 'RVnB'}`,
      `<p>Hi ${esc(booking.guest_name)},</p><p>Your trip at <b>${spot}</b> for ${dates} has been cancelled.</p><p>${esc(outcome.message)}${plan === 'refund' ? ' Refunds usually show up within 5–10 business days, depending on your bank.' : ''}</p>`);

    // Notify the host that a spot opened back up
    if (booking.partners?.host_id) {
      const { data: hostProfile } = await adminClient
        .from('profiles').select('email').eq('id', booking.partners.host_id).single();
      await sendEmail(RESEND_API_KEY, hostProfile?.email, `Cancellation — ${booking.partners.business_name}`,
        `<p>Hi,</p><p><b>${esc(booking.guest_name)}</b>'s booking for ${dates} has been cancelled. That spot is available again.</p>`);
    }

    return json({ success: true, outcome });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
