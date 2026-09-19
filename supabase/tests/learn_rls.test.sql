-- Learn Mode RLS (issue #15). Run with `supabase test db`.
begin;
select plan(35);

-- Two users. auth.uid() reads request.jwt.claims ->> 'sub'.
insert into auth.users (id, instance_id, aud, role, email, is_anonymous)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a@example.com', false),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', null, true);

create or replace function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;

-- 1. A inserts a topic and root + child nodes, and reads them back ------------------

select pg_temp.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

insert into public.learn_topics (id, title)
values ('10000000-0000-4000-8000-000000000001', 'Photosynthesis');

select is(user_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'topic user_id defaults to auth.uid()')
  from public.learn_topics where id = '10000000-0000-4000-8000-000000000001';

insert into public.learn_nodes (id, topic_id, kind, body)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'root', 'Plants turn light into sugar.');

insert into public.learn_nodes (id, topic_id, parent_id, kind, label, after_block, body)
values ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001', 'deeper', 'light', 0, 'Light reactions...');

select is(count(*), 1::bigint, 'A reads back her topic') from public.learn_topics;
select is(count(*), 2::bigint, 'A reads back both nodes') from public.learn_nodes;
select is(user_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'node user_id defaults to auth.uid()')
  from public.learn_nodes where id = '20000000-0000-4000-8000-000000000002';
select is(mastery, 'read', 'mastery defaults to read')
  from public.learn_nodes where id = '20000000-0000-4000-8000-000000000001';

-- A second topic of A's, for test 5.
insert into public.learn_topics (id, title)
values ('10000000-0000-4000-8000-000000000002', 'Respiration');
insert into public.learn_nodes (id, topic_id, kind)
values ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'root');

-- 2. B sees nothing of A's and cannot update / delete it -------------------------------

reset role;
select pg_temp.login('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

select is(count(*), 0::bigint, 'B sees none of A''s topics') from public.learn_topics;
select is(count(*), 0::bigint, 'B sees none of A''s nodes') from public.learn_nodes;

with u as (
  update public.learn_topics set title = 'pwned'
  where id = '10000000-0000-4000-8000-000000000001' returning 1
) select is(count(*), 0::bigint, 'B cannot update A''s topic') from u;

with u as (
  update public.learn_nodes set body = 'pwned'
  where id = '20000000-0000-4000-8000-000000000001' returning 1
) select is(count(*), 0::bigint, 'B cannot update A''s node') from u;

with d as (
  delete from public.learn_nodes where id = '20000000-0000-4000-8000-000000000002' returning 1
) select is(count(*), 0::bigint, 'B cannot delete A''s node') from d;

with d as (
  delete from public.learn_topics where id = '10000000-0000-4000-8000-000000000001' returning 1
) select is(count(*), 0::bigint, 'B cannot delete A''s topic') from d;

-- 3. B cannot insert a node into A's topic ------------------------------------------------

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, kind)
     values ('20000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-000000000001', 'root') $$,
  '42501', null, 'B cannot insert a node into A''s topic');

-- 4. B cannot hang a node in her own topic under one of A's nodes -------------------------

insert into public.learn_topics (id, title)
values ('10000000-0000-4000-8000-0000000000b1', 'B topic');

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, parent_id, kind)
     values ('20000000-0000-4000-8000-0000000000b2', '10000000-0000-4000-8000-0000000000b1',
             '20000000-0000-4000-8000-000000000001', 'deeper') $$,
  '42501', null, 'B cannot use one of A''s nodes as parent');

-- B can still write her own root + child (sanity check that the policy is not over-tight).
insert into public.learn_nodes (id, topic_id, kind)
values ('20000000-0000-4000-8000-0000000000b3', '10000000-0000-4000-8000-0000000000b1', 'root');
insert into public.learn_nodes (id, topic_id, parent_id, kind)
values ('20000000-0000-4000-8000-0000000000b4', '10000000-0000-4000-8000-0000000000b1',
        '20000000-0000-4000-8000-0000000000b3', 'ask');
select is(count(*), 2::bigint, 'B (anonymous user) reads back her own nodes') from public.learn_nodes;
select is(count(*), 1::bigint, 'B sees only her own topic') from public.learn_topics;

-- 5. A cannot use a parent from a different topic of her own -----------------------------

reset role;
select pg_temp.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, parent_id, kind)
     values ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002',
             '20000000-0000-4000-8000-000000000001', 'deeper') $$,
  '42501', null, 'parent must belong to the same topic');

select throws_ok(
  $$ update public.learn_nodes set parent_id = '20000000-0000-4000-8000-000000000001'
     where id = '20000000-0000-4000-8000-000000000003' $$,
  '42501', null, 'update cannot re-parent a node across topics');

-- 6. Writing a node bumps the topic's updated_at -----------------------------------------

reset role;
update public.learn_topics set updated_at = '2000-01-01'
  where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

insert into public.learn_nodes (id, topic_id, parent_id, kind)
values ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002', 'simplify');

select is(updated_at, now(), 'inserting a node bumps the topic updated_at')
  from public.learn_topics where id = '10000000-0000-4000-8000-000000000001';

reset role;
update public.learn_topics set updated_at = '2000-01-01'
  where id = '10000000-0000-4000-8000-000000000001';
update public.learn_nodes set updated_at = '2000-01-01'
  where id = '20000000-0000-4000-8000-000000000005';
select pg_temp.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

update public.learn_nodes set mastery = 'taught'
  where id = '20000000-0000-4000-8000-000000000005';

select is(updated_at, now(), 'updating a node bumps the topic updated_at')
  from public.learn_topics where id = '10000000-0000-4000-8000-000000000001';
select is(updated_at, now(), 'updating a node bumps its own updated_at')
  from public.learn_nodes where id = '20000000-0000-4000-8000-000000000005';

-- 7. Deleting a topic cascades to its nodes ------------------------------------------------

delete from public.learn_topics where id = '10000000-0000-4000-8000-000000000001';
select is(count(*), 0::bigint, 'deleting a topic cascades to its nodes')
  from public.learn_nodes where topic_id = '10000000-0000-4000-8000-000000000001';
select is(count(*), 1::bigint, 'A''s other topic survives') from public.learn_topics;

-- 8. Invalid kind / mastery rejected ------------------------------------------------------

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, kind)
     values ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000002', 'bogus') $$,
  '23514', null, 'invalid kind is rejected');

select throws_ok(
  $$ update public.learn_nodes set mastery = 'guru'
     where id = '20000000-0000-4000-8000-000000000003' $$,
  '23514', null, 'invalid mastery is rejected');

select throws_ok(
  $$ insert into public.learn_topics (title) values ('') $$,
  '23514', null, 'empty title is rejected');

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, kind, body)
     values ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002',
             'root', repeat('x', 20001)) $$,
  '23514', null, 'body over 20000 chars is rejected');

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, kind, extras)
     values ('20000000-0000-4000-8000-000000000008', '10000000-0000-4000-8000-000000000002',
             'root', jsonb_build_object('suggestions', array[repeat('y', 20000)])) $$,
  '23514', null, 'extras over 16 KiB is rejected');

select throws_ok(
  $$ insert into public.learn_nodes (id, topic_id, kind, question)
     values ('20000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000002',
             'root', repeat('q', 1001)) $$,
  '23514', null, 'question over 1000 chars is rejected');

select throws_ok(
  $$ insert into public.learn_topics (title, language) values ('T', repeat('l', 41)) $$,
  '23514', null, 'language over 40 chars is rejected');

-- 9. Storage: learn-diagrams ------------------------------------------------------------------

reset role;
select is(count(*), 1::bigint, 'learn-diagrams bucket exists and is private')
  from storage.buckets where id = 'learn-diagrams' and public = false
    and file_size_limit = 5242880
    and allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];
select pg_temp.login('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

insert into storage.objects (bucket_id, name)
values ('learn-diagrams',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000003.png');
select is(count(*), 1::bigint, 'A can insert an object under her own folder')
  from storage.objects where bucket_id = 'learn-diagrams';

select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('learn-diagrams',
             'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/20000000-0000-4000-8000-000000000003.png') $$,
  '42501', null, 'A cannot insert an object under B''s folder');

reset role;
select pg_temp.login('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
select is(count(*), 0::bigint, 'B cannot select A''s object')
  from storage.objects where bucket_id = 'learn-diagrams';

-- The bare anon role (no session) has no access at all.
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.learn_topics $$, '42501', null,
  'anon role has no access to learn_topics');
select throws_ok($$ select count(*) from public.learn_nodes $$, '42501', null,
  'anon role has no access to learn_nodes');

reset role;
select * from finish();
rollback;
