# PewterDesk Cloud (Supabase)

The hosted store for the Plan page (trading plan, playbooks, the journal,
trade notes and their screenshots) and PewterDesk AI's chats. Why it's Supabase and what it may hold:
[ADR 0004](../docs/adr/0004-hosted-journal.md). The app reaches it from Rust
only (`apps/desktop/src-tauri/src/cloud.rs`).

## Set up a project

1. Create a project at [supabase.com](https://supabase.com) (or self-host).
2. Apply the schema, either with the CLI:

   ```sh
   supabase link --project-ref <ref>
   supabase db push
   ```

   or by pasting `migrations/*.sql`, in order, into the SQL editor. This
   creates the six tables with Row Level Security (`ai_chats` and
   `notifications` among them),
   and the private `journal` storage bucket.
3. **Authentication → Providers → Email**: on. Turn "Confirm email" on.
4. **Authentication → Email Templates → Magic Link** (and **Confirm
   signup**): the app signs in with a code, not a link, so the template must
   include the code, for example:

   ```html
   <h2>Your PewterDesk sign-in code</h2>
   <p>{{ .Token }}</p>
   ```

5. **Authentication → URL Configuration**: nothing is needed; no link is
   followed.
6. Project Settings → API: copy the project URL and the `anon` public key.

## Build the app against it

The project is fixed at build time. Put the two values in `.env.cloud` at
the repo root (gitignored; see `.env.cloud.example`), which every `make`
target passes on to cargo and Tauri:

```sh
PEWTERDESK_CLOUD_URL=https://<ref>.supabase.co
PEWTERDESK_CLOUD_KEY=<anon key>
```

or export them in the shell before `cargo` / `tauri` builds. Release builds
need them as CI variables. A build without them runs normally, and the Plan
page says there's no cloud.

The anon key is public by design: it identifies the project, and every table
refuses it (`revoke all ... from anon`). What protects the data is Row Level
Security, with each user's own session.

## Changing the schema

Add a new file under `migrations/` (never edit an applied one). If the page
gets a new collection or column, `cloud.rs`'s `Collection` and `row` must
allow it explicitly - and that is a security-relevant change (CLAUDE.md).
