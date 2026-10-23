// Supabase Edge Function: capture-payment
//
// Called when a host or admin clicks "Confirm" on a booking. This is the
// moment the traveler's card actually gets charged — before this, it was
// only authorized (held), not charged.
//
// Security: this function verifies the caller is either the admin or the
// actual host who owns the listing being booked, using the service role key
// to check server-side — it does not trust anything the client claims.
//
// Also emails the traveler their confirmation (trip details, times, rules)
// and returns emailedGuest: true, so the host dashboard, admin page and app
// don't each send their own copy.

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

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function formatTime12hr(hhmm: string | null) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function sendConfirmationEmail(resendKey: string | undefined, b: any): Promise<boolean> {
  if (!resendKey || !b.guest_email) return false;
  const p = b.partners || {};
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0; color:#555;">${label}</td><td>${value}</td></tr>`;
  const html = `
    <p>Hi ${esc(b.guest_name)},</p>
    <p>Your booking is confirmed! Your card has been charged. Here are your trip details:</p>
    <table style="border-collapse:collapse; margin:14px 0;">
      ${row('Location', `<b>${esc(p.business_name)}</b>`)}
      ${row('Address', esc(`${p.address}, ${p.city}, ${p.state}`))}
      ${row('Check-in date', formatDate(b.check_in))}
      ${row('Check-out date', formatDate(b.check_out))}
      ${p.allows_24hr_parking ? '' : row('Arrive after', formatTime12hr(p.arrival_time)) + row('Leave by', formatTime12hr(p.departure_time))}
      ${b.total_charged ? row('Total paid', `$${Number(b.total_charged).toFixed(2)}`) : ''}
    </table>
    ${p.rules ? `<p><b>Host rules:</b><br>${esc(p.rules)}</p>` : ''}
    ${p.allows_24hr_parking
      ? `<p><b>24-hour parking.</b> This is a designated RV spot — you're welcome to stay parked for the full length of your booking without leaving and returning daily.</p>`
      : `<p><b>⚠ Daily departure required.</b> Even for multi-night stays, your vehicle must leave the lot by <b>${formatTime12hr(p.departure_time)}</b> each morning and may not return until <b>${formatTime12hr(p.arrival_time)}</b> that evening — every night of your stay, not just once.</p>`}
    <p>Safe travels!</p>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'RVnB <notifications@tryrvnb.com>',
      to: [b.guest_email],
      reply_to: 'hello@hivebuilt.dev',
      subject: `Booking confirmed — ${p.business_name} (${p.city}, ${p.state})`,
      html,
    }),
  }).catch(() => null);
  return !!res?.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { bookingId } = await req.json();
    if (!bookingId) throw new Error('bookingId is required');

    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Identify who's calling
    const { data: userData, error: userErr } = await adminClient.auth.getUser(callerJwt);
    if (userErr || !userData?.user) return json({ error: 'Not authenticated' }, 401);

    // Look up the booking and its listing's host
    const { data: booking, error: bookingErr } = await adminClient
      .from('bookings')
      .select('id, payment_intent_id, payment_status, status, guest_name, guest_email, check_in, check_out, total_charged, partners(host_id, business_name, address, city, state, arrival_time, departure_time, allows_24hr_parking, rules)')
      .eq('id', bookingId)
      .single();
    if (bookingErr || !booking) return json({ error: 'Booking not found' }, 404);

    const isAdmin = userData.user.email === ADMIN_EMAIL;
    const isHost = (booking.partners as any)?.host_id === userData.user.id;
    if (!isAdmin && !isHost) return json({ error: 'Not authorized to act on this booking' }, 403);

    if (booking.payment_status !== 'authorized') {
      return json({ error: `Cannot capture — payment status is "${booking.payment_status}", expected "authorized"` }, 400);
    }

    // Actually capture the charge with Stripe
    const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${booking.payment_intent_id}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
    });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) return json({ error: stripeData.error?.message || 'Stripe capture failed' }, 400);

    // Update the booking now that the charge succeeded
    await adminClient
      .from('bookings')
      .update({ status: 'confirmed', payment_status: 'paid' })
      .eq('id', bookingId);

    const emailedGuest = await sendConfirmationEmail(Deno.env.get('RESEND_API_KEY'), booking);
    return json({ success: true, emailedGuest });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
