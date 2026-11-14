import { t } from "@pewterdesk/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * PewterDesk Cloud (`src-tauri/src/cloud.rs`): the hosted store for the plan,
 * playbooks, journal and trade notes, and PewterDesk AI's chats. Every request is built and sent by
 * Rust; the page names a collection and hands over a record's data. The
 * session's tokens never reach the page.
 */

export type Collection = "plans" | "playbooks" | "journalDays" | "tradeNotes" | "ideas";

export interface CloudRecord<T = unknown> {
  id?: string;
  accountKey?: string;
  /** `YYYY-MM-DD`, UTC. */
  day?: string;
  tradeKey?: string;
  playbookId?: string;
  data: T;
  updatedAt?: string;
}

export interface CloudQuery {
  accountKey?: string;
  from?: string;
  to?: string;
  tradeKey?: string;
  playbookId?: string;
}

export interface CloudStatus {
  configured: boolean;
  email: string | null;
}

type RustCloudError =
  | { kind: "notConfigured" }
  | { kind: "signedOut" }
  | { kind: "invalid"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "network"; detail: string };

/** An error from the cloud, with whether it means "sign in again". */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly signedOut = false,
  ) {
    super(message);
  }
}

function describe(raw: unknown): CloudError {
  const e = raw as RustCloudError | undefined;
  switch (e?.kind) {
    case "notConfigured":
      return new CloudError(t("cloud.err.notConfigured"));
    case "signedOut":
      return new CloudError(t("cloud.err.signedOut"), true);
    case "invalid":
      return new CloudError(t("cloud.err.invalid", { detail: e.detail }));
    case "rejected":
      return new CloudError(e.detail);
    case "network":
      return new CloudError(e.detail);
    default:
      return new CloudError(typeof raw === "string" ? raw : t("cloud.err.unknown"));
  }
}

async function call<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
  if (!isTauri()) throw new CloudError(t("error.noTauri"));
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw describe(e);
  }
}

export const cloudClient = {
  status: () => call<CloudStatus>("cloud_status"),
  sendCode: (email: string) => call<void>("cloud_send_code", { email }),
  verify: (email: string, code: string) => call<string>("cloud_verify", { email, code }),
  signOut: () => call<void>("cloud_sign_out"),
  list: <T>(collection: Collection, query?: CloudQuery) =>
    call<CloudRecord<T>[]>("cloud_list", { collection, query }),
  put: <T>(collection: Collection, record: CloudRecord<T>) =>
    call<CloudRecord<T>>("cloud_put", { collection, record }),
  remove: (collection: Collection, id: string) => call<void>("cloud_delete", { collection, id }),
  /** Stores a PNG or JPEG; returns its path for a record to name. */
  upload: (bytes: Uint8Array) => call<string>("cloud_upload", bytes),
  /** An attachment as a `data:` URL (the CSP's `img-src` allows those, not `blob:`). */
  attachment: async (path: string): Promise<string> => {
    const bytes = await call<ArrayBuffer>("cloud_attachment", { path });
    const type = path.endsWith(".png") ? "image/png" : "image/jpeg";
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new CloudError(t("cloud.err.unknown")));
      reader.readAsDataURL(new Blob([bytes], { type }));
    });
  },
  removeAttachment: (path: string) => call<void>("cloud_remove_attachment", { path }),
  /** PewterDesk AI's chats, newest first: what the list shows of each. */
  aiChats: () => call<AiChatSummary[]>("cloud_ai_chats"),
  /** One chat whole; null if it's gone. */
  aiChat: (key: string) => call<AiChatRecord | null>("cloud_ai_chat", { key }),
  /** Writes a chat: `meta` always, the messages and transcript only when given. */
  putAiChat: (key: string, parts: AiChatParts) => call<void>("cloud_put_ai_chat", { key, parts }),
  removeAiChat: (key: string) => call<void>("cloud_delete_ai_chat", { key }),
  /** The notification centre's notifications, newest first. */
  notifications: () => call<NoteRecord[]>("cloud_notifications"),
  /** Writes notifications, new or changed (read), as one batch. */
  putNotifications: (notes: readonly NoteRecord[]) =>
    call<void>("cloud_put_notifications", { notes }),
  /** Deletes the notifications named, or every one with none named (Clear). */
  removeNotifications: (keys?: readonly string[]) =>
    call<void>("cloud_delete_notifications", { keys: keys ?? null }),
};

/** One notification as the cloud keeps it: its id, its time, and what the centre shows. */
export interface NoteRecord {
  key: string;
  at: number;
  note: unknown;
}

export interface AiChatSummary {
  key: string;
  meta: unknown;
  updatedAt: string;
}

export interface AiChatRecord {
  key: string;
  meta: unknown;
  messages: unknown;
  transcript: unknown;
}

export interface AiChatParts {
  meta: Record<string, unknown>;
  messages?: unknown[];
  transcript?: unknown;
}
