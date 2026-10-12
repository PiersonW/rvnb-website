// Supabase Edge Function: cancel-payment
//
// Called when a host or admin declines, cancels, or refunds a booking.
// Verifies the caller is the admin or the actual host before touching anything.
//
//   - Pending request (card only held): releases the hold. Host or admin.
//   - Confirmed and charged: cancels and fully refunds the traveler — per the
//     cancellation policy, a host cancellation is always a full refund. Host or admin.
//   - Admin only: refund a custom amount ({ amount } in dollars) on any charged
//     booking, including completed or already-cancelled ones (policy exceptions),
//     optionally without cancelling ({ cancel: false }), with a note.
//
// Emails the traveler whenever money is refunded. (Plain declines are still
// emailed by the host/admin page.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ADMIN_EMAIL = 'pierson.willhite@gmail.com'; // update if your admin email changes

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
    const { bookingId, amount, cancel, note } = await req.json();
    if (!bookingId) throw new Error('bookingId is required');

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData, error: userErr } = await adminClient.auth.getUser(callerJwt);
    if (userErr || !userData?.user) return json({ error: 'Not authenticated' }, 401);

    const { data: booking, error: bookingErr } = await adminClient
      .from('bookings')
      .select('*, partners(business_name, host_id)')
      .eq('id', bookingId)
      .single();
    if (bookingErr || !booking) return json({ error: 'Booking not found' }, 404);

    const isAdmin = userData.user.email === ADMIN_EMAIL;
    const isHost = booking.partners && booking.partners.host_id === userData.user.id;
    if (!isAdmin && !isHost) return json({ error: 'Not authorized to act on this booking' }, 403);
    const actor = isAdmin ? 'admin' : 'host';

    // 1. Pending request with a card hold: release it.
    if (booking.payment_status === 'authorized') {
      if (booking.payment_intent_id) {
        const { ok, data } = await stripePost(`payment_intents/${booking.payment_intent_id}/cancel`, STRIPE_SECRET_KEY);
        if (!ok && data.error?.code !== 'payment_intent_unexpected_state') {
          return json({ error: data.error?.message || 'Stripe cancel failed' }, 400);
        }
      }
      await adminClient.from('bookings')
        .update({ status: 'cancelled', payment_status: 'cancelled', cancelled_by: actor })
        .eq('id', bookingId);
      return json({ success: true, released: true, refundAmount: 0 });
    }

    // 2. Charged booking: refund.
    const remainingCents = toCents(booking.total_charged ?? booking.total_price) - toCents(booking.refunded_amount);
    const charged = ['paid', 'partially_refunded'].includes(booking.payment_status) && booking.payment_intent_id;

    if (!charged || remainingCents <= 0) {
      // Nothing left to refund — a host/admin cancelling an unpaid booking.
      if (booking.status === 'cancelled' || booking.status === 'completed') {
        return json({ error: 'There is nothing left to refund on this booking.' }, 400);
      }
      await adminClient.from('bookings')
        .update({ status: 'cancelled', cancelled_by: actor })
        .eq('id', bookingId);
      return json({ success: true, refundAmount: 0 });
    }

    let refundCents = remainingCents;
    let shouldCancel = true;
    if (isAdmin) {
      if (amount !== undefined && amount !== null && amount !== '') {
        refundCents = toCents(amount);
        if (!(refundCents > 0 && refundCents <= remainingCents)) {
          return json({ error: `Refund must be between $0.01 and $${(remainingCents / 100).toFixed(2)}.` }, 400);
        }
      }
      shouldCancel = cancel !== false && booking.status !== 'completed' && booking.status !== 'cancelled';
    } else {
      // Host: cancelling a confirmed stay is always a full refund. Completed
      // stays and exceptions go through the admin.
      if (booking.status !== 'confirmed') {
        return json({ error: 'Only confirmed bookings can be cancelled here. Contact RVnB for help with this booking.' }, 400);
      }
    }

    const params = new URLSearchParams();
    params.append('payment_intent', booking.payment_intent_id);
    params.append('amount', String(refundCents));
    params.append('reason', 'requested_by_customer');
    params.append('metadata[booking_id]', booking.id);
    params.append('metadata[refunded_by]', actor);
    if (note) params.append('metadata[note]', String(note).slice(0, 450));
    const { ok, data } = await stripePost('refunds', STRIPE_SECRET_KEY, params,
      `rvnb-refund-${booking.id}-${toCents(booking.refunded_amount)}-${refundCents}`);
    if (!ok) return json({ error: data.error?.message || 'Stripe refund failed' }, 400);

    const refundedTotalCents = toCents(booking.refunded_amount) + refundCents;
    const fullyRefunded = refundedTotalCents >= toCents(booking.total_charged ?? booking.total_price);
    await adminClient.from('bookings')
      .update({
        payment_status: fullyRefunded ? 'refunded' : 'partially_refunded',
        refunded_amount: refundedTotalCents / 100,
        refunded_at: new Date().toISOString(),
        ...(note ? { refund_note: String(note).slice(0, 1000) } : {}),
        ...(shouldCancel ? { status: 'cancelled', cancelled_by: actor } : {}),
      })
      .eq('id', bookingId);

    const spot = esc(booking.partners?.business_name || 'your listing');
    const dollars = `$${(refundCents / 100).toFixed(2)}`;
    await sendEmail(RESEND_API_KEY, booking.guest_email,
      shouldCancel ? `Booking cancelled — refund issued` : `Refund issued — ${booking.partners?.business_name || 'RVnB'}`,
      `<p>Hi ${esc(booking.guest_name)},</p>` +
      (shouldCancel
        ? `<p>Your booking at <b>${spot}</b> for ${booking.check_in} → ${booking.check_out} has been cancelled${actor === 'host' ? ' by the host' : ''}.</p>`
        : `<p>We've issued a refund for your stay at <b>${spot}</b> (${booking.check_in} → ${booking.check_out}).</p>`) +
      `<p>A refund of <b>${dollars}</b> is on its way to your original payment method. It usually shows up within 5–10 business days, depending on your bank.</p>` +
      (shouldCancel ? `<p>Sorry for the trouble — feel free to look for another spot on <a href="https://tryrvnb.com/browse.html">RVnB</a>.</p>` : ''));

    return json({ success: true, refundAmount: refundCents / 100, cancelled: shouldCancel, emailedGuest: true });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
