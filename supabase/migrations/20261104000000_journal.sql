-- PewterDesk's hosted store: the trading plan, playbooks, journal and trade
-- notes (docs/adr/0004-hosted-journal.md). Nothing here is key material:
-- no venue key, signature, signed payload or keychain reference ever goes in.
--
-- Every table is owned row by row: Row Level Security limits each signed-in
-- user to their own rows, so the API (PostgREST) is the only server there is.
-- The app reaches it from Rust only (`apps/desktop/src-tauri/src/cloud.rs`).
--
-- Each record keeps its evolving shape in `data` (jsonb, written whole by the
-- app) and the few fields that are looked up or kept unique as columns.

create extension if not exists pgcrypto;

-- Keeps updated_at honest whatever the client sends.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- One trading plan per account (venue:address).
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_key text not null check (char_length(account_key) between 1 and 200),
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_key)
);

-- A setup written the same way every time; shared by the user's plans.
create table public.playbooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One journal entry per account and trading day (UTC): check-in, pre-market,
-- session notes and the end-of-day review.
create table public.journal_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_key text not null check (char_length(account_key) between 1 and 200),
  day date not null,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_key, day)
);

-- What the trader wrote about one closed trade. The trade itself (fills,
-- prices, P&L) stays the venue's: `trade_key` names it, and `data` keeps a
-- copy of its figures so analytics read without the venue.
create table public.trade_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_key text not null check (char_length(account_key) between 1 and 200),
  trade_key text not null check (char_length(trade_key) between 1 and 200),
  day date not null,
  playbook_id uuid references public.playbooks (id) on delete set null,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_key, trade_key)
);

create index journal_days_by_day on public.journal_days (user_id, account_key, day desc);
create index trade_notes_by_day on public.trade_notes (user_id, account_key, day desc);
create index trade_notes_by_playbook on public.trade_notes (playbook_id);

do $$
declare
  t text;
begin
  foreach t in array array['plans', 'playbooks', 'journal_days', 'trade_notes'] loop
    execute format(
      'create trigger touch before update on public.%I
         for each row execute function public.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    -- No access at all without a signed-in user.
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- Screenshots attached to a trade or a day: private, under the owner's id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journal', 'journal', false, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

create policy "own journal files: read" on storage.objects for select to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own journal files: write" on storage.objects for insert to authenticated
  with check (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own journal files: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);
