// Supabase Edge Function: send-email
//
// Sends email through Resend from notifications@tryrvnb.com.
//
// Who can send to whom: earlier versions accepted any caller (the public anon
// key counts as a valid JWT), which made this an open relay anyone could use
// to send arbitrary email from tryrvnb.com. Now:
//   - the admin can email anyone;
//   - any other logged-in user can only email themselves, or the other side
//     of a booking / listing they're part of (guest <-> host, listing contact).
// Anonymous callers are refused. Booking-request emails for guests without
// accounts are sent by confirm-booking instead.

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

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { to, subject, html, replyTo } = await req.json();
    if (!to || !subject || !html || typeof to !== 'string') {
      return json({ error: 'to, subject, and html are all required' }, 400);
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('Missing required Edge Function secrets');
    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured in Edge Function secrets');
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const callerJwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData } = await adminClient.auth.getUser(callerJwt);
    const user = userData?.user;
    if (!user) return json({ error: 'Please log in to send email.' }, 401);

    const recipient = norm(to);
    let allowed = norm(user.email) === norm(ADMIN_EMAIL) || recipient === norm(user.email);

    if (!allowed) {
      // Listings this user hosts: their contact emails, and guests who booked them.
      const { data: myListings } = await adminClient
        .from('partners').select('id, contact_email').eq('host_id', user.id);
      const myListingIds = (myListings || []).map((p) => p.id);
      if ((myListings || []).some((p) => norm(p.contact_email) === recipient)) allowed = true;

      if (!allowed && myListingIds.length) {
        const { data: guests } = await adminClient
          .from('bookings').select('guest_email').in('partner_id', myListingIds);
        if ((guests || []).some((b) => norm(b.guest_email) === recipient)) allowed = true;
      }

      // Bookings this user made as a traveler: the host of that listing.
      if (!allowed) {
        const { data: trips } = await adminClient
          .from('bookings').select('partners(host_id)').eq('traveler_id', user.id);
        const hostIds = [...new Set((trips || []).map((t: any) => t.partners?.host_id).filter(Boolean))];
        if (hostIds.length) {
          const { data: hosts } = await adminClient.from('profiles').select('email').in('id', hostIds);
          if ((hosts || []).some((h) => norm(h.email) === recipient)) allowed = true;
        }
      }
    }

    if (!allowed) return json({ error: 'Not allowed to email that address.' }, 403);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'RVnB <notifications@tryrvnb.com>',
        to: [to],
        subject: String(subject).slice(0, 300),
        html,
        // Replies land in a real inbox even though there's no @tryrvnb.com mailbox behind the sending address
        reply_to: norm(user.email) === norm(ADMIN_EMAIL) && replyTo ? replyTo : ADMIN_EMAIL,
      }),
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data.message || 'Resend error' }, 400);
    return json({ success: true });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
