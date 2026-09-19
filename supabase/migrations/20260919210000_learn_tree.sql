-- Learn Mode storage (issue #15): learn trees, their nodes, and the diagram bucket.
-- The browser talks to Supabase directly with the publishable key, so RLS is the
-- whole security model. Additive only (see NOTES.md).

create table public.learn_topics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  language    text not null default 'English',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.learn_nodes (
  id          uuid primary key,
  topic_id    uuid not null references public.learn_topics (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  parent_id   uuid references public.learn_nodes (id) on delete cascade,
  kind        text not null check (kind in ('root', 'deeper', 'ask', 'simplify', 'visual')),
  label       text not null default '' check (char_length(label) <= 400),
  question    text not null default '',
  after_block int,
  body        text not null default '',
  extras      jsonb,
  image_path  text,
  mastery     text not null default 'read'
              check (mastery in ('unseen', 'read', 'taught', 'shaky', 'solid')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index learn_topics_user_id_updated_at_idx on public.learn_topics (user_id, updated_at desc);
create index learn_nodes_topic_id_idx on public.learn_nodes (topic_id);
create index learn_nodes_parent_id_idx on public.learn_nodes (parent_id);

-- updated_at maintenance -------------------------------------------------------

create or replace function public.learn_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger learn_topics_set_updated_at
  before update on public.learn_topics
  for each row execute function public.learn_set_updated_at();

create trigger learn_nodes_set_updated_at
  before update on public.learn_nodes
  for each row execute function public.learn_set_updated_at();

-- Any write to a node bumps its topic: the topics list is ordered by updated_at.
create or replace function public.learn_bump_topic_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.learn_topics set updated_at = now() where id = new.topic_id;
  return new;
end;
$$;

revoke all on function public.learn_bump_topic_updated_at() from public, anon, authenticated;

create trigger learn_nodes_bump_topic
  after insert or update on public.learn_nodes
  for each row execute function public.learn_bump_topic_updated_at();

-- Row-Level Security --------------------------------------------------------------
-- Anonymous-auth users carry role `authenticated` (is_anonymous = true), so they get
-- the same access as signed-up users. The bare `anon` role gets nothing.

alter table public.learn_topics enable row level security;
alter table public.learn_nodes  enable row level security;

revoke all on public.learn_topics from anon;
revoke all on public.learn_nodes  from anon;
grant select, insert, update, delete on public.learn_topics to authenticated;
grant select, insert, update, delete on public.learn_nodes  to authenticated;

create policy "learn_topics: owner select" on public.learn_topics
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "learn_topics: owner insert" on public.learn_topics
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "learn_topics: owner update" on public.learn_topics
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "learn_topics: owner delete" on public.learn_topics
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "learn_nodes: owner select" on public.learn_nodes
  for select to authenticated
  using (user_id = (select auth.uid()));

-- FK checks bypass RLS, so a user who learned another user's node id could otherwise
-- hang a child under it. A policy on learn_nodes cannot query learn_nodes itself
-- (Postgres reports infinite policy recursion), so the parent check lives in a
-- security-definer function that requires the parent to be the caller's own node in
-- the same topic.
create or replace function public.learn_parent_ok(p_parent_id uuid, p_topic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_parent_id is null or exists (
    select 1 from public.learn_nodes p
    where p.id = p_parent_id
      and p.topic_id = p_topic_id
      and p.user_id = auth.uid()
  );
$$;

revoke all on function public.learn_parent_ok(uuid, uuid) from public, anon;
grant execute on function public.learn_parent_ok(uuid, uuid) to authenticated;

create policy "learn_nodes: owner insert" on public.learn_nodes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.learn_topics t
      where t.id = topic_id and t.user_id = (select auth.uid())
    )
    and public.learn_parent_ok(parent_id, topic_id)
  );

create policy "learn_nodes: owner update" on public.learn_nodes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.learn_topics t
      where t.id = topic_id and t.user_id = (select auth.uid())
    )
    and public.learn_parent_ok(parent_id, topic_id)
  );

create policy "learn_nodes: owner delete" on public.learn_nodes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Storage: private bucket for kind = 'visual' diagrams at <auth.uid()>/<node_id>.png ---

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('learn-diagrams', 'learn-diagrams', false, 5242880,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "learn-diagrams: owner select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'learn-diagrams'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "learn-diagrams: owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'learn-diagrams'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "learn-diagrams: owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'learn-diagrams'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'learn-diagrams'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "learn-diagrams: owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'learn-diagrams'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
