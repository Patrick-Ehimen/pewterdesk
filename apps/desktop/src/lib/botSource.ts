import { t } from "@pewterdesk/ui";
import type { BotDraft, BotEvent, BotView, SavedRun } from "./bots";

// Where the Bots panel and page read bots from, and send what the trader
// asks of them. The engine that would run bots isn't in this build, so the
// app's source is `noEngine`: nothing to show, and nothing can start. When
// it lands, its source goes here, over Tauri commands like the algos'
// (`venueClient`), and every order a bot sends goes through the router.

export interface BotHandlers {
  onBot: (bot: BotView) => void;
  onEvent: (event: BotEvent) => void;
  /** Whether the engine can be reached, and when it last could. */
  onLink: (reachable: boolean, at: number) => void;
}

export interface BotSource {
  /** Whether an engine runs these bots; without one, nothing can start. */
  readonly engine: boolean;
  /** Set on the demo source, so its bots are never taken for real ones. */
  readonly demo?: boolean;
  list: () => Promise<BotView[]>;
  events: (limit: number) => Promise<BotEvent[]>;
  runs: () => Promise<SavedRun[]>;
  subscribe: (handlers: BotHandlers) => () => void;
  start: (draft: BotDraft) => Promise<BotView>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  /** Stops a bot and cancels its resting orders; `close` also closes its position at market. */
  stop: (id: string, close: boolean) => Promise<void>;
  /** Pauses every bot and cancels their resting orders. How many it paused. */
  halt: () => Promise<number>;
}

const refuse = () => Promise.reject(new Error(t("bots.noEngine")));

/** No engine: no bots, no saved runs, and every action refused. */
export const noEngine: BotSource = {
  engine: false,
  list: async () => [],
  events: async () => [],
  runs: async () => [],
  subscribe: () => () => {},
  start: refuse,
  pause: refuse,
  resume: refuse,
  stop: refuse,
  halt: refuse,
};
