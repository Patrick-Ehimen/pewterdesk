-- The notes panel: the trader's own free-text notes, opened from the
-- header beside the notifications. Each is an id and its `data` (jsonb,
-- written whole by the app: the text and its times), like an idea. A note
-- names no account or trade and places nothing. Nothing here is key
-- material: no venue key, signature, signed payload or keychain reference
-- ever goes in.
--
-- Reached from Rust only (`apps/desktop/src-tauri/src/cloud.rs`).

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_by_time on public.notes (user_id, updated_at desc);

create trigger touch before update on public.notes
  for each row execute function public.touch_updated_at();
alter table public.notes enable row level security;
alter table public.notes force row level security;
create policy "own rows" on public.notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No access at all without a signed-in user.
revoke all on public.notes from anon;
grant select, insert, update, delete on public.notes to authenticated;
