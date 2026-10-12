// Supabase Edge Function: process-payouts
//
// Sends hosts their share of each finished stay. Runs hourly from pg_cron
// (see migrations/20261012_host_payouts.sql) and can also be called with
// { bookingId } to process one booking right away (e.g. after the host marks
// a stay completed).
//
// A booking is paid out once:
//   - it was charged (paid / partially refunded) and is confirmed or completed,
//   - checkout has passed (check-out date at the listing's departure time, Utah time),
//   - it hasn't been paid out yet.
// The host receives host_payout (listed price minus RVnB's 12%), reduced in
// proportion to any refund already issued. Money goes to the host's Stripe
// Express account via a Transfer tied to the original charge, then Stripe
// pays it out to their bank on their normal payout schedule.
//
// Hosts who haven't finished Stripe onboarding are marked waiting_on_host and
// retried every run, so they're paid as soon as they finish setting up.
//
// Safe to call any number of times: a booking is claimed before transferring,
// and Stripe is checked for an existing transfer for that booking first.
// "Enforce JWT verification" is OFF so pg_cron can call it without a login;
// it takes no instructions beyond an optional booking id, and only ever pays
// what is already owed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  let utc = naive - offsetMinutes(naive) * 60000;
  utc = naive - offsetMinutes(utc) * 60000;
  return utc;
}

const toCents = (n: unknown) => Math.round(Number(n || 0) * 100);

async function stripe(path: string, key: string, method = 'GET', params?: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${key}` };
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body: params?.toString() });
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

// Errors that mean "the host's Stripe account can't receive money yet" —
// worth retrying once they finish onboarding, not a real failure.
function isHostSetupError(err: any) {
  const text = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return /capabilit|transfers|payouts|onboarding|account.*(restricted|not|cannot)|no such destination|insufficient_capabilities/.test(text);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let bookingId: string | undefined;
    try { ({ bookingId } = await req.json()); } catch { /* no body from cron */ }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY) {
      throw new Error('Missing required Edge Function secrets');
    }
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Candidates: charged, not cancelled, not yet paid out, checkout date reached.
    // (The exact checkout time is checked per booking below.)
    const tomorrowUtc = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    let query = adminClient
      .from('bookings')
      .select('*, partners(business_name, host_id, departure_time)')
      .in('payment_status', ['paid', 'partially_refunded'])
      .in('status', ['confirmed', 'completed'])
      .or('payout_status.is.null,payout_status.eq.waiting_on_host,payout_status.eq.failed')
      .lte('check_out', tomorrowUtc)
      .limit(50);
    if (bookingId) query = query.eq('id', bookingId);
    const { data: bookings, error } = await query;
    if (error) throw error;

    // Same review-request emails the host dashboard sends on "Mark Completed".
    async function sendReviewRequests(b: any, hostEmail?: string | null) {
      const reviewBase = `https://tryrvnb.com/review.html?booking=${b.id}`;
      const spot = esc(b.partners?.business_name || 'your spot');
      await sendEmail(RESEND_API_KEY, b.guest_email, `How was your stay at ${b.partners?.business_name || 'RVnB'}?`,
        `<p>Hi ${esc(b.guest_name)},</p><p>Thanks for staying at <b>${spot}</b> through RVnB. Mind leaving a quick review?</p><p><a href="${reviewBase}&as=traveler">Leave a review →</a></p>`);
      await sendEmail(RESEND_API_KEY, hostEmail, `How was hosting ${b.guest_name}?`,
        `<p>Hi,</p><p>Your guest <b>${esc(b.guest_name)}</b> just completed their stay. Mind leaving a quick review?</p><p><a href="${reviewBase}&as=host">Leave a review →</a></p>`);
    }

    const results: Record<string, string> = {};

    for (const b of bookings || []) {
      const checkoutMs = localToUtcMs(b.check_out, b.partners?.departure_time || '12:00', LISTING_TIMEZONE);
      if (Date.now() < checkoutMs) { results[b.id] = 'not_due'; continue; }

      const wasConfirmed = b.status === 'confirmed';
      const totalCents = toCents(b.total_charged ?? b.total_price);
      const refundedCents = toCents(b.refunded_amount);
      const amountCents = totalCents > 0
        ? Math.round(toCents(b.host_payout) * Math.max(0, totalCents - refundedCents) / totalCents)
        : 0;

      if (amountCents <= 0) {
        await adminClient.from('bookings')
          .update({ payout_status: 'not_owed', payout_amount: 0, status: 'completed' })
          .eq('id', b.id);
        results[b.id] = 'not_owed';
        continue;
      }

      const { data: host } = await adminClient
        .from('profiles').select('email, stripe_account_id').eq('id', b.partners?.host_id).single();
      if (!host?.stripe_account_id) {
        await adminClient.from('bookings')
          .update({ payout_status: 'waiting_on_host', payout_amount: amountCents / 100, payout_error: 'Host has not set up payouts yet.', status: 'completed' })
          .eq('id', b.id);
        results[b.id] = 'waiting_on_host';
        if (wasConfirmed) await sendReviewRequests(b, host?.email);
        continue;
      }

      // Claim it so a concurrent run can't pay the same booking.
      const { data: claimed } = await adminClient.from('bookings')
        .update({ payout_status: 'processing' })
        .eq('id', b.id)
        .or('payout_status.is.null,payout_status.eq.waiting_on_host,payout_status.eq.failed')
        .select('id');
      if (!claimed?.length) { results[b.id] = 'claimed_elsewhere'; continue; }

      const transferGroup = `rvnb_booking_${b.id}`;
      let transferId: string | null = null;

      // Already transferred (e.g. a previous run died before saving)? Reuse it.
      const existing = await stripe(`transfers?transfer_group=${transferGroup}&limit=1`, STRIPE_SECRET_KEY);
      if (existing.ok && existing.data.data?.length) transferId = existing.data.data[0].id;

      if (!transferId) {
        const pi = await stripe(`payment_intents/${b.payment_intent_id}`, STRIPE_SECRET_KEY);
        const params = new URLSearchParams();
        params.append('amount', String(amountCents));
        params.append('currency', 'usd');
        params.append('destination', host.stripe_account_id);
        params.append('transfer_group', transferGroup);
        if (pi.ok && pi.data.latest_charge) params.append('source_transaction', pi.data.latest_charge);
        params.append('description', `${b.partners?.business_name || 'RVnB stay'}: ${b.check_in} to ${b.check_out}`);
        params.append('metadata[booking_id]', b.id);
        // Hour-scoped key: a retry next hour after a fixed problem isn't stuck on a cached error.
        const hourKey = new Date().toISOString().slice(0, 13);
        const t = await stripe('transfers', STRIPE_SECRET_KEY, 'POST', params, `rvnb-payout-${b.id}-${amountCents}-${hourKey}`);
        if (!t.ok) {
          const waiting = isHostSetupError(t.data.error);
          await adminClient.from('bookings')
            .update({
              payout_status: waiting ? 'waiting_on_host' : 'failed',
              payout_amount: amountCents / 100,
              payout_error: t.data.error?.message || 'Transfer failed',
              status: 'completed',
            })
            .eq('id', b.id);
          results[b.id] = waiting ? 'waiting_on_host' : 'failed';
          if (wasConfirmed) await sendReviewRequests(b, host.email);
          continue;
        }
        transferId = t.data.id;
      }

      await adminClient.from('bookings')
        .update({
          payout_status: 'paid',
          payout_amount: amountCents / 100,
          payout_transfer_id: transferId,
          paid_out_at: new Date().toISOString(),
          payout_error: null,
          status: 'completed',
        })
        .eq('id', b.id);
      results[b.id] = 'paid';

      await sendEmail(RESEND_API_KEY, host.email, `You've been paid — ${b.partners?.business_name || 'RVnB'}`,
        `<p>Hi,</p><p>Your payout of <b>$${(amountCents / 100).toFixed(2)}</b> for <b>${esc(b.guest_name)}</b>'s stay (${b.check_in} → ${b.check_out}) is on its way. It'll land in your bank on your normal Stripe payout schedule, usually within a few business days.</p><p><a href="https://tryrvnb.com/host-dashboard.html">View your bookings</a></p>`);
      if (wasConfirmed) await sendReviewRequests(b, host.email);
    }

    return json({ processed: Object.keys(results).length, results });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
