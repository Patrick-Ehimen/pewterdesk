import { cloudClient, type NoteRecord } from "../api/cloudClient";
import { type AppNote, currentNotes, mergeNotes, subscribeNotes } from "./notifications";

// The notification centre in PewterDesk Cloud, once the trader is signed in
// (the Plan page's or the AI page's sign-in: one session). On sign-in the
// cloud's notifications are merged into the centre; from then on, what's
// new or newly read here goes up, in batches a few seconds apart, and Clear
// clears the cloud's too. A notification that drops off this machine's
// list (it keeps the newest 200) stays in the cloud. Signed out, nothing
// leaves the machine. Reached from Rust only (`cloud.rs`); no key material.

/** Between a change and its write, so a burst goes up as one batch. */
const FLUSH_MS = 3_000;
/** How often to look whether the trader has signed in (or out) meanwhile. */
const STATUS_MS = 2 * 60_000;
/** As the cloud takes them in one write. */
const BATCH = 200;
/** The app's ids for notifications are UUIDs; anything else stays on this machine. */
const KEY = /^[a-z0-9-]{1,64}$/;

let signedIn = false;
/** What the cloud holds, by id: whether it's read there. */
let synced = new Map<string, boolean>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let started = false;

const toRecord = (n: AppNote): NoteRecord => ({ key: n.id, at: n.time, note: n });

function fromRecord(r: NoteRecord): AppNote | undefined {
  const note = r.note as Partial<AppNote> | null;
  if (!note || typeof note !== "object") return undefined;
  return { ...(note as AppNote), id: r.key, time: r.at };
}

function schedule() {
  if (!signedIn) return;
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), FLUSH_MS);
}

async function flush() {
  if (!signedIn || flushing) return;
  flushing = true;
  try {
    const local = currentNotes().filter((n) => KEY.test(n.id));
    // Cleared here: cleared there too.
    if (local.length === 0 && synced.size > 0) {
      await cloudClient.removeNotifications();
      synced = new Map();
      return;
    }
    const changed = local.filter((n) => synced.get(n.id) !== n.read);
    for (let i = 0; i < changed.length; i += BATCH) {
      const batch = changed.slice(i, i + BATCH);
      await cloudClient.putNotifications(batch.map(toRecord));
      for (const n of batch) synced.set(n.id, n.read);
    }
  } catch {
    // Kept here; the next change or look tries again.
  } finally {
    flushing = false;
  }
}

/** Reads the cloud's notifications into the centre, and what's only here up to it. */
async function connect() {
  try {
    const remote = await cloudClient.notifications();
    synced = new Map(remote.map((r) => [r.key, (r.note as Partial<AppNote>)?.read === true]));
    mergeNotes(remote.flatMap((r) => fromRecord(r) ?? []));
    signedIn = true;
    await flush();
  } catch {
    signedIn = false;
  }
}

async function look() {
  const status = await cloudClient.status().catch(() => undefined);
  const now = status?.configured === true && status.email !== null;
  if (now && !signedIn) await connect();
  else if (!now && signedIn) {
    signedIn = false;
    synced = new Map();
  }
}

/** Starts keeping the centre in the cloud, for the main window, once. */
export function startNotesCloud() {
  if (started) return;
  started = true;
  subscribeNotes(schedule);
  void look();
  setInterval(() => void look(), STATUS_MS);
}
