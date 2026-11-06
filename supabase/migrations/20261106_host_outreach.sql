-- Host outreach: personal emails to Utah businesses with a link that opens
-- list-your-lot.html already filled in for them (?claim=<token>).
--
-- Builds on host_leads (the admin's lead list, Host Leads tab). Each lead
-- gets a claim token, a pre-filled draft, and tracking columns:
--   emailed      -> status 'contacted'  (send-outreach edge function)
--   opened link  -> status 'interested' (rvnb_outreach_open)
--   submitted    -> status 'listed'     (rvnb_outreach_claim)
--   unsubscribed -> status 'declined'   (rvnb_outreach_unsubscribe)
-- Unsubscribes also go into outreach_suppressions, keyed by email, so they
-- stick even if the lead is deleted and imported again.

-- Wider set of lead types: the outreach list is farms, wineries, breweries,
-- golf courses and venues, not only storage.
alter table public.host_leads drop constraint if exists host_leads_business_type_check;
alter table public.host_leads add constraint host_leads_business_type_check check (
  business_type is null or business_type = any (array[
    'storage','church','gym','farm','winery','brewery','golf','venue','restaurant','retail','other'
  ])
);

alter table public.host_leads
  add column if not exists website text,
  add column if not exists source text,            -- where we found them, e.g. 'own website', 'Google Maps'
  add column if not exists personal_line text,     -- the one true, specific sentence that opens the email
  add column if not exists draft jsonb not null default '{}'::jsonb,  -- list-your-lot prefill (business_type, price_per_night, spots_available, ...)
  add column if not exists claim_token text,
  add column if not exists do_not_contact boolean not null default false,
  add column if not exists emailed_at timestamptz,
  add column if not exists email_count integer not null default 0,
  add column if not exists last_email_id text,     -- Resend message id
  add column if not exists link_opened_at timestamptz,
  add column if not exists link_last_opened_at timestamptz,
  add column if not exists link_open_count integer not null default 0,
  add column if not exists listing_id uuid references public.partners(id) on delete set null,
  add column if not exists listed_at timestamptz,
  add column if not exists unsubscribed_at timestamptz;

update public.host_leads set claim_token = replace(gen_random_uuid()::text, '-', '')
where claim_token is null;
alter table public.host_leads alter column claim_token set default replace(gen_random_uuid()::text, '-', '');
alter table public.host_leads alter column claim_token set not null;
create unique index if not exists host_leads_claim_token_key on public.host_leads (claim_token);
create unique index if not exists host_leads_email_key on public.host_leads (lower(email)) where email is not null;

-- Emails that must never get outreach again.
create table if not exists public.outreach_suppressions (
  email text primary key check (email = lower(email)),
  reason text,
  created_at timestamptz not null default now()
);
alter table public.outreach_suppressions enable row level security;
create policy outreach_suppressions_admin_all on public.outreach_suppressions
  for all using ((select public.rvnb_is_admin())) with check ((select public.rvnb_is_admin()));
revoke all on public.outreach_suppressions from anon;
grant select, insert, update, delete on public.outreach_suppressions to authenticated;
grant select, insert, update, delete on public.outreach_suppressions to service_role;

-- Opens a claim link: returns the prefill for list-your-lot.html. p_record
-- counts it as a visit (the first landing from the email); the page passes
-- false when it re-reads the draft after a sign-in redirect.
create or replace function public.rvnb_outreach_open(p_token text, p_record boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.host_leads;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  if p_record then
    update public.host_leads set
      link_open_count = link_open_count + 1,
      link_opened_at = coalesce(link_opened_at, now()),
      link_last_opened_at = now(),
      status = case when status in ('not_contacted', 'contacted') then 'interested' else status end,
      updated_at = now()
    where claim_token = p_token
    returning * into l;
  else
    select * into l from public.host_leads where claim_token = p_token;
  end if;
  if l.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'business_name', l.business_name,
    'address', l.address,
    'city', l.city,
    'state', coalesce(l.state, 'UT'),
    'contact_name', l.contact_name,
    'email', l.email,
    'draft', l.draft,
    'listed', l.listing_id is not null
  );
end;
$$;

-- Ties a submitted listing to the lead whose link the host came from.
-- Only the listing's own host can claim it.
create or replace function public.rvnb_outreach_claim(p_token text, p_listing_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_token is null then
    return false;
  end if;
  if not exists (select 1 from public.partners where id = p_listing_id and host_id = auth.uid()) then
    return false;
  end if;
  update public.host_leads set
    listing_id = p_listing_id,
    listed_at = now(),
    status = 'listed',
    updated_at = now()
  where claim_token = p_token and listing_id is null;
  return found;
end;
$$;

-- Unsubscribe link in every outreach email (unsubscribe.html?t=<token>).
create or replace function public.rvnb_outreach_unsubscribe(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if p_token is null or length(p_token) < 32 then
    return false;
  end if;
  update public.host_leads set
    do_not_contact = true,
    unsubscribed_at = coalesce(unsubscribed_at, now()),
    status = case when status = 'listed' then status else 'declined' end,
    updated_at = now()
  where claim_token = p_token
  returning lower(email) into v_email;
  if not found then
    return false;
  end if;
  if v_email is not null then
    insert into public.outreach_suppressions (email, reason) values (v_email, 'unsubscribe link')
    on conflict (email) do nothing;
  end if;
  return true;
end;
$$;

revoke all on function public.rvnb_outreach_open(text, boolean) from public;
revoke all on function public.rvnb_outreach_claim(text, uuid) from public, anon;
revoke all on function public.rvnb_outreach_unsubscribe(text) from public;
grant execute on function public.rvnb_outreach_open(text, boolean) to anon, authenticated;
grant execute on function public.rvnb_outreach_claim(text, uuid) to authenticated;
grant execute on function public.rvnb_outreach_unsubscribe(text) to anon, authenticated;
