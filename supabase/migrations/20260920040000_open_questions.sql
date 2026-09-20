-- Open questions (issue #51): questions a student asked that the teacher left hanging.
-- The browser talks to Supabase directly with the publishable key, so RLS is the
-- whole security model. Additive only (see NOTES.md).

create table public.open_questions (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Nullable, and deliberately `set null` rather than `cascade`: a question can come from a
  -- session that never had a Learn Mode tree, and deleting a tree must not delete the
  -- questions it raised. topic_title is what the page groups by, so it has to outlive this.
  topic_id     uuid references public.learn_topics (id) on delete set null,
  topic_title  text not null check (char_length(topic_title) between 1 and 200),
  language     text not null default 'English' check (char_length(language) <= 40),
  question     text not null check (char_length(question) between 1 and 1000),
  -- Why it is still open. The distinction is the product: a question waved away is not the
  -- same as one answered wrongly, and the page says which.
  reason       text not null check (reason in ('deferred', 'skipped', 'wrong', 'unanswered')),
  created_at   timestamptz not null default now(),
  -- Null means open. Closing is a timestamp, never a delete: a question you dismissed is
  -- still evidence about the session it came from.
  closed_at    timestamptz
);

-- The page's only hot query: my open questions, newest first.
create index open_questions_user_open_idx
  on public.open_questions (user_id, closed_at, created_at desc);
create index open_questions_topic_id_idx on public.open_questions (topic_id);

-- Row-level security ------------------------------------------------------------

alter table public.open_questions enable row level security;

revoke all on public.open_questions from anon;
grant select, insert, update, delete on public.open_questions to authenticated;

create policy "open_questions: owner select" on public.open_questions
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "open_questions: owner insert" on public.open_questions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "open_questions: owner update" on public.open_questions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "open_questions: owner delete" on public.open_questions
  for delete to authenticated
  using (user_id = (select auth.uid()));
