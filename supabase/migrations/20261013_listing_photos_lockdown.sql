-- listing-photos let anyone (even signed out) upload any file of any size to
-- a public bucket - free public file hosting on tryrvnb's Supabase URL for
-- whoever found it. Listing photos only ever come from signed-in hosts
-- (list-your-lot.html and the app both require an account), so require
-- that, and only accept images up to 10 MB.

update storage.buckets
set file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
where id = 'listing-photos';

drop policy if exists "Anyone can upload listing photos" on storage.objects;
drop policy if exists "Signed-in users can upload listing photos" on storage.objects;
create policy "Signed-in users can upload listing photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'listing-photos');
