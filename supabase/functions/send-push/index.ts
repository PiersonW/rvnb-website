// Supabase Edge Function: send-push
//
// Delivers a notification to every device a user has: Web Push for browsers
// that subscribed on tryrvnb.com (push_subscriptions), and Expo push for the
// iOS/Android app (expo_push_tokens). Called by a database trigger every time
// a row is inserted into `notifications`, so every notification type (new
// booking, booking confirmed/declined/cancelled, new message, listing
// approved, new listing submitted) becomes a push on both, with no duplicated
// logic per event. It also emails a host's message to a guest who booked
// without an account (see notify_new_message).
//
// "Verify JWT" stays OFF: it's called from the database, not a logged-in
// browser. The x-push-secret header (PUSH_TRIGGER_SECRET) is what keeps
// strangers from hitting this URL and spamming real users.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-push-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Known pg_net 0.20.3 bug: its own auto-generated headers (User-Agent,
// Content-Length) sometimes leak into the body ahead of the JSON payload.
// The real payload is still there - recover it from the first '{'.
function parseBody(rawBody: string) {
  try {
    return JSON.parse(rawBody);
  } catch {
    const jsonStart = rawBody.indexOf('{');
    if (jsonStart === -1) return null;
    try {
      const parsed = JSON.parse(rawBody.slice(jsonStart));
      console.warn('send-push recovered JSON after stripping a leaked header prefix:', rawBody.slice(0, jsonStart));
      return parsed;
    } catch {
      return null;
    }
  }
}

async function sendWebPush(supabaseAdmin: any, userId: string, payload: string) {
  const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
  const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets - skipping web push');
    return 0;
  }
  webpush.setVapidDetails('mailto:hello@hivebuilt.dev', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const { data: subs, error } = await supabaseAdmin.from('push_subscriptions').select('*').eq('user_id', userId);
  if (error) throw error;

  let sent = 0;
  for (const sub of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent++;
    } catch (err: any) {
      // 404/410 = the browser unsubscribed or the subscription expired.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('Web push failed for subscription', sub.id, err?.message || err);
      }
    }
  }
  return sent;
}

async function sendExpoPush(supabaseAdmin: any, userId: string, title: string, message: string, link: string) {
  const { data: tokens, error } = await supabaseAdmin.from('expo_push_tokens').select('token').eq('user_id', userId);
  if (error) throw error;
  if (!tokens?.length) return 0;

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(
      tokens.map((t: { token: string }) => ({
        to: t.token,
        title,
        body: message,
        sound: 'default',
        data: { link },
      })),
    ),
  });
  const result = await res.json().catch(() => null);
  if (!res.ok) {
    console.error('Expo push request failed:', res.status, JSON.stringify(result));
    return 0;
  }

  // Tickets come back in the same order as the messages. DeviceNotRegistered
  // means the app was deleted or notifications were turned off for good.
  let sent = 0;
  const tickets = result?.data || [];
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket?.status === 'ok') sent++;
    else if (ticket?.details?.error === 'DeviceNotRegistered') {
      await supabaseAdmin.from('expo_push_tokens').delete().eq('token', tokens[i].token);
    } else {
      console.error('Expo push ticket error:', JSON.stringify(ticket));
    }
  }
  return sent;
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

// A host messaged a traveler who booked as a guest and has no account to push
// to (notify_new_message sends { guest_booking_id, message }). Email them the
// message with a link to sign in with the booking's email and reply.
async function emailGuest(supabaseAdmin: any, bookingId: string, message: string) {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  if (!RESEND_API_KEY) return json({ error: 'Missing RESEND_API_KEY' }, 500);

  const { data: b } = await supabaseAdmin
    .from('bookings')
    .select('traveler_id, guest_email, guest_name, check_in, check_out, partners(business_name)')
    .eq('id', bookingId)
    .single();
  // Claimed since the message was sent? Then they'll get it in the app instead.
  if (!b?.guest_email || b.traveler_id) return json({ emailed: false });

  const spot = b.partners?.business_name || 'your RVnB booking';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'RVnB <notifications@tryrvnb.com>',
      to: [b.guest_email],
      reply_to: 'hello@hivebuilt.dev',
      subject: `New message from your host at ${spot}`,
      html:
        `<p>Hi ${esc(b.guest_name)},</p>` +
        `<p>Your host at <b>${esc(spot)}</b> (${esc(b.check_in)} → ${esc(b.check_out)}) sent you a message:</p>` +
        `<blockquote style="border-left:3px solid #e0ddd0;margin:0;padding:4px 12px;white-space:pre-wrap">${esc(String(message || '').slice(0, 2000))}</blockquote>` +
        `<p>To reply, <a href="https://tryrvnb.com/traveler-login.html">sign in to RVnB</a> or the RVnB app with <b>${esc(b.guest_email)}</b>. Your booking will be waiting under Trips.</p>`,
    }),
  }).catch(() => null);
  if (!res?.ok) console.error('Guest message email failed:', res?.status, await res?.text().catch(() => ''));
  return json({ emailed: !!res?.ok });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const PUSH_TRIGGER_SECRET = Deno.env.get('PUSH_TRIGGER_SECRET');
    if (!PUSH_TRIGGER_SECRET || req.headers.get('x-push-secret') !== PUSH_TRIGGER_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const rawBody = await req.text();
    const parsedBody = parseBody(rawBody);
    if (!parsedBody) {
      console.error('send-push received a body with no recoverable JSON (first 500 chars):', rawBody.slice(0, 500));
      return json({ error: 'Request body was not valid JSON' }, 400);
    }

    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (parsedBody.guest_booking_id) {
      return await emailGuest(supabaseAdmin, parsedBody.guest_booking_id, parsedBody.message);
    }

    const { user_id, title, message, link } = parsedBody;
    if (!user_id || !title) return json({ error: 'user_id and title are required' }, 400);

    const payload = JSON.stringify({ title, body: message || '', link: link || '/' });

    // One channel failing shouldn't stop the other.
    const [web, app] = await Promise.allSettled([
      sendWebPush(supabaseAdmin, user_id, payload),
      sendExpoPush(supabaseAdmin, user_id, title, message || '', link || ''),
    ]);
    if (web.status === 'rejected') console.error('Web push error:', web.reason);
    if (app.status === 'rejected') console.error('Expo push error:', app.reason);

    return json({
      sent: (web.status === 'fulfilled' ? web.value : 0) + (app.status === 'fulfilled' ? app.value : 0),
      web: web.status === 'fulfilled' ? web.value : 'error',
      app: app.status === 'fulfilled' ? app.value : 'error',
    });
  } catch (err) {
    console.error('send-push error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
