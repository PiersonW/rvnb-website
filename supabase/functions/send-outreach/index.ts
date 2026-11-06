// Supabase Edge Function: send-outreach
//
// Admin-only. Sends the personal "I drafted a listing for you" email to host
// leads (host_leads), each with their own claim link that opens
// list-your-lot.html already filled in, and an unsubscribe link.
//
// POST body:
//   { mode: 'preview' }               -> renders the next batch, sends nothing
//   { mode: 'test' }                  -> sends the first email of the next batch to the admin only
//   { mode: 'send', limit?: number }  -> sends the next batch for real
//   lead_ids?: string[]               -> only these leads (still skips anyone not eligible)
//
// Who gets an email: has an email, status 'not_contacted', never emailed,
// not do_not_contact, not in outreach_suppressions, and has a personal_line
// (no generic blasts). At most DAILY_CAP real emails per Utah day.
//
// Secrets: RESEND_API_KEY (shared), OUTREACH_FROM (e.g. "Pierson at RVnB
// <pierson@go.tryrvnb.com>", a Resend-verified domain kept apart from
// notifications@tryrvnb.com), OUTREACH_REPLY_TO, OUTREACH_MAILING_ADDRESS
// (required by CAN-SPAM; sending refuses without it).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ADMIN_EMAIL = 'pierson.willhite@gmail.com';
const SITE = 'https://tryrvnb.com';
const DAILY_CAP = Number(Deno.env.get('OUTREACH_DAILY_CAP') || 25);
const TZ = 'America/Denver';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Lead = {
  id: string; business_name: string; contact_name: string | null; email: string;
  city: string | null; personal_line: string | null; claim_token: string;
};

// Start of today in Utah, as an ISO instant.
function startOfUtahDay(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const sinceMidnightMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
  return new Date(now.getTime() - sinceMidnightMs - now.getMilliseconds()).toISOString();
}

// "Monte and Shauna Phelps" -> "Monte and Shauna"; "Kailin Beck" -> "Kailin".
function firstName(contact: string | null): string | null {
  const c = (contact || '').trim();
  const pair = c.match(/^([A-Za-z'’-]{2,})\s+(?:and|&)\s+([A-Za-z'’-]{2,})/);
  if (pair) return `${pair[1]} and ${pair[2]}`;
  const first = c.split(/\s+/)[0];
  return first && /^[A-Za-z'’-]{2,}$/.test(first) ? first : null;
}

export function renderEmail(lead: Lead, mailingAddress: string) {
  const claimUrl = `${SITE}/list-your-lot.html?claim=${lead.claim_token}`;
  const unsubUrl = `${SITE}/unsubscribe.html?t=${lead.claim_token}`;
  const hello = firstName(lead.contact_name) ? `Hi ${firstName(lead.contact_name)},` : `Hi ${lead.business_name} team,`;
  const subject = `Overnight RV guests at ${lead.business_name}?`;
  const paragraphs = [
    hello,
    (lead.personal_line || '').trim(),
    `I run RVnB, a Utah site where RV travelers book a paid overnight spot at local businesses, farms and properties. It's one more place to be found, alongside anywhere you already list.`,
    `It's free to list. You set the price and the nights you're open, you approve every request, and travelers pay online. You keep 88% of the nightly price, paid out to you automatically after each stay.`,
    `I drafted a listing for ${lead.business_name} from your public info, so it only takes a couple of minutes to check it, add a photo and submit:`,
  ];
  const signoff = ['Thanks,', 'Pierson Willhite', 'RVnB · tryrvnb.com'];
  const footer = `Not a fit? Reply "no", or unsubscribe here, and I won't email you again: ${unsubUrl}`;

  const text = [...paragraphs, claimUrl, signoff.join('\n'), footer, `Hivebuilt LLC (d/b/a RVnB), ${mailingAddress}`].join('\n\n');
  const p = (s: string) => `<p style="margin:0 0 14px">${esc(s)}</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1E2B25;max-width:560px">
${paragraphs.map(p).join('\n')}
<p style="margin:0 0 14px"><a href="${esc(claimUrl)}" style="color:#2D6A4F;font-weight:bold">Review your RVnB listing</a></p>
<p style="margin:0 0 14px">${signoff.map(esc).join('<br>')}</p>
<p style="margin:24px 0 0;font-size:12px;color:#66756D">Not a fit? Reply "no", or <a href="${esc(unsubUrl)}" style="color:#66756D">unsubscribe</a>, and I won't email you again.<br>Hivebuilt LLC (d/b/a RVnB), ${esc(mailingAddress)}</p>
</div>`;
  return { subject, text, html, claimUrl, unsubUrl };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const FROM = Deno.env.get('OUTREACH_FROM');
    const REPLY_TO = Deno.env.get('OUTREACH_REPLY_TO') || 'hello@hivebuilt.dev';
    const MAILING_ADDRESS = Deno.env.get('OUTREACH_MAILING_ADDRESS') || '';
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: userData } = await db.auth.getUser(jwt);
    if (userData?.user?.email?.toLowerCase() !== ADMIN_EMAIL) return json({ error: 'Admin only' }, 403);

    const body = await req.json().catch(() => ({}));
    const mode: 'preview' | 'test' | 'send' = ['preview', 'test', 'send'].includes(body.mode) ? body.mode : 'preview';

    const since = startOfUtahDay();
    const { count: sentToday } = await db.from('host_leads')
      .select('id', { count: 'exact', head: true }).gte('emailed_at', since);
    const remainingToday = Math.max(0, DAILY_CAP - (sentToday || 0));
    const limit = Math.min(Number(body.limit) || DAILY_CAP, DAILY_CAP);

    let query = db.from('host_leads')
      .select('id, business_name, contact_name, email, city, personal_line, claim_token')
      .not('email', 'is', null)
      .eq('status', 'not_contacted')
      .is('emailed_at', null)
      .eq('do_not_contact', false)
      .order('created_at', { ascending: true })
      .limit(200);
    if (Array.isArray(body.lead_ids) && body.lead_ids.length) query = query.in('id', body.lead_ids);
    const { data: candidates, error } = await query;
    if (error) throw error;

    const { data: suppressed } = await db.from('outreach_suppressions').select('email');
    const blocked = new Set((suppressed || []).map((s) => s.email));
    const skipped: { business_name: string; reason: string }[] = [];
    const eligible: Lead[] = [];
    for (const l of (candidates || []) as Lead[]) {
      if (blocked.has(l.email.toLowerCase())) { skipped.push({ business_name: l.business_name, reason: 'unsubscribed earlier' }); continue; }
      if (!(l.personal_line || '').trim()) { skipped.push({ business_name: l.business_name, reason: 'needs a personal line' }); continue; }
      eligible.push(l);
    }

    const address = MAILING_ADDRESS || '[mailing address not set yet]';
    if (mode === 'preview') {
      const batch = eligible.slice(0, Math.min(limit, remainingToday || limit));
      return json({
        sentToday: sentToday || 0, dailyCap: DAILY_CAP, remainingToday, readyTotal: eligible.length,
        ready: !!(RESEND_API_KEY && FROM && MAILING_ADDRESS),
        missing: [!FROM && 'OUTREACH_FROM', !MAILING_ADDRESS && 'OUTREACH_MAILING_ADDRESS', !RESEND_API_KEY && 'RESEND_API_KEY'].filter(Boolean),
        skipped,
        emails: batch.map((l) => ({ id: l.id, to: l.email, business_name: l.business_name, ...renderEmail(l, address) })),
      });
    }

    if (!RESEND_API_KEY || !FROM || !MAILING_ADDRESS) {
      return json({ error: 'Outreach sending is not set up yet. Missing: ' + [!FROM && 'OUTREACH_FROM', !MAILING_ADDRESS && 'OUTREACH_MAILING_ADDRESS', !RESEND_API_KEY && 'RESEND_API_KEY'].filter(Boolean).join(', ') }, 400);
    }

    const send = async (to: string, e: ReturnType<typeof renderEmail>) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM, to, reply_to: REPLY_TO, subject: e.subject, text: e.text, html: e.html,
          headers: { 'List-Unsubscribe': `<${e.unsubUrl}>, <mailto:${REPLY_TO}?subject=unsubscribe>` },
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out?.message || `Resend ${res.status}`);
      return out.id as string;
    };

    if (mode === 'test') {
      const lead = eligible[0];
      if (!lead) return json({ error: 'No lead is ready to email.' }, 400);
      const e = renderEmail(lead, MAILING_ADDRESS);
      const id = await send(ADMIN_EMAIL, { ...e, subject: '[TEST] ' + e.subject });
      return json({ test: true, to: ADMIN_EMAIL, business_name: lead.business_name, id });
    }

    const batch = eligible.slice(0, Math.min(limit, remainingToday));
    const results: { business_name: string; to: string; ok: boolean; error?: string }[] = [];
    for (const lead of batch) {
      try {
        const id = await send(lead.email, renderEmail(lead, MAILING_ADDRESS));
        await db.from('host_leads').update({
          emailed_at: new Date().toISOString(), email_count: 1, last_email_id: id, status: 'contacted',
          last_touch_date: new Date().toLocaleDateString('en-CA', { timeZone: TZ }), updated_at: new Date().toISOString(),
        }).eq('id', lead.id);
        results.push({ business_name: lead.business_name, to: lead.email, ok: true });
      } catch (err) {
        results.push({ business_name: lead.business_name, to: lead.email, ok: false, error: (err as Error).message });
      }
      // Space them out a little, like a person sending one at a time.
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
    return json({ sent: results.filter((r) => r.ok).length, results, skipped, sentToday: (sentToday || 0) + results.filter((r) => r.ok).length, dailyCap: DAILY_CAP });
  } catch (err) {
    console.error('send-outreach error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
