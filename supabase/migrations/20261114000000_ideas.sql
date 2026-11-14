-- The Ideas page: a coin the trader is watching, what they think it will do
-- and why, the price levels that matter, and their thoughts as it plays out,
-- with screenshots. Kept apart from the journal and from trades: an idea
-- names no account and places nothing. Nothing here is key material: no
-- venue key, signature, signed payload or keychain reference ever goes in.
--
-- An idea is an id and its `data` (jsonb, written whole by the app), like a
-- playbook. Its screenshots are stored in the `journal` bucket, under the
-- user's own folder, and named in `data` by their path.
--
-- Reached from Rust only (`apps/desktop/src-tauri/src/cloud.rs`).

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ideas_by_time on public.ideas (user_id, updated_at desc);

create trigger touch before update on public.ideas
  for each row execute function public.touch_updated_at();
alter table public.ideas enable row level security;
alter table public.ideas force row level security;
create policy "own rows" on public.ideas for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No access at all without a signed-in user.
revoke all on public.ideas from anon;
grant select, insert, update, delete on public.ideas to authenticated;
