-- The notification centre's notifications (the bell in the app's header),
-- kept in the cloud once the trader signs in, so they survive a reinstall and
-- follow the trader to another computer. Nothing here is key material: no
-- API key, venue key, signature or keychain reference ever goes in. A
-- notification is what the app told the trader - an order placed, a fill, a
-- position change, a fired alert, a liquidation warning - as bounded text,
-- with its venue and market, its time and whether it's been read.
--
-- Reached from Rust only (`apps/desktop/src-tauri/src/cloud.rs`).

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The app's own id for the notification.
  note_key text not null check (note_key ~ '^[a-z0-9-]{1,64}$'),
  -- When it happened, in milliseconds since the Unix epoch: the list's order.
  at bigint not null check (at > 0),
  -- Type, title, body, tone, venue, market, read: what the centre shows.
  note jsonb not null check (octet_length(note::text) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, note_key)
);

create index notifications_by_time on public.notifications (user_id, at desc);

create trigger touch before update on public.notifications
  for each row execute function public.touch_updated_at();
alter table public.notifications enable row level security;
alter table public.notifications force row level security;
create policy "own rows" on public.notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- No access at all without a signed-in user.
revoke all on public.notifications from anon;
grant select, insert, update, delete on public.notifications to authenticated;
