-- PewterDesk AI's chats (the AI page), kept in the cloud rather than on the
-- trader's machine. Nothing here is key material: no API key, venue key,
-- signature or keychain reference ever goes in. A chat holds the trader's
-- questions, the analyst's answers, the sources it cited (bounded text and
-- ids, never a URL), and the provider's own transcript, handed back whole
-- with the next question - which, with account access on, includes what the
-- analyst read of the trader's account (positions, orders, fills).
--
-- Reached from Rust only (`apps/desktop/src-tauri/src/cloud.rs`): the list
-- reads `meta` alone; a chat's messages and transcript are read when it's
-- opened.

create table public.ai_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The app's own id for the chat.
  chat_key text not null check (chat_key ~ '^[a-z0-9-]{1,64}$'),
  -- Title, mode, provider, model, market: what the list shows.
  meta jsonb not null default '{}'::jsonb check (octet_length(meta::text) <= 16384),
  messages jsonb not null default '[]'::jsonb check (octet_length(messages::text) <= 2097152),
  transcript jsonb check (transcript is null or octet_length(transcript::text) <= 5242880),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, chat_key)
);

create index ai_chats_by_update on public.ai_chats (user_id, updated_at desc);

create trigger touch before update on public.ai_chats
  for each row execute function public.touch_updated_at();
alter table public.ai_chats enable row level security;
alter table public.ai_chats force row level security;
create policy "own rows" on public.ai_chats for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No access at all without a signed-in user.
revoke all on public.ai_chats from anon;
grant select, insert, update, delete on public.ai_chats to authenticated;
