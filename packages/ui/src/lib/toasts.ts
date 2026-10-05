import type { OrderRequest } from "@pewterdesk/core";
import { t } from "../i18n";
import { formatNumber } from "./format";

/**
 * How a toast reads: `buy` and `sell` are fills and position changes on that
 * side (market colors), `warn` something that didn't go through, `neutral`
 * the rest.
 */
export type ToastTone = "neutral" | "buy" | "sell" | "warn";

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
  /** Milliseconds since the Unix epoch. */
  time: number;
}

/** Toasts kept on screen at once; older ones drop off. */
const MAX_SHOWN = 5;
/** How long a toast stays; failures stay longer, to be read. */
const STAY_MS = 6000;
const WARN_STAY_MS = 12_000;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function set(next: readonly Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

/** Shows a toast; returns its id. Callable from anywhere, React or not. */
export function toast(input: { title: string; body?: string; tone?: ToastTone }): number {
  const id = nextId++;
  const tone = input.tone ?? "neutral";
  const dropped = toasts.length >= MAX_SHOWN ? toasts.slice(0, toasts.length - MAX_SHOWN + 1) : [];
  for (const d of dropped) clearTimeout(timers.get(d.id));
  set([
    ...toasts.slice(dropped.length),
    { id, title: input.title, body: input.body, tone, time: Date.now() },
  ]);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), tone === "warn" ? WARN_STAY_MS : STAY_MS),
  );
  return id;
}

/** A failure, from whatever was thrown: its message, or `fallback`. */
export function toastError(title: string, err: unknown, fallback?: string) {
  const body = err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  return toast({ title, body, tone: "warn" });
}

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (toasts.some((x) => x.id === id)) set(toasts.filter((x) => x.id !== id));
}

export function clearToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (toasts.length > 0) set([]);
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toastsState() {
  return toasts;
}

/** An order in a line: "Buy 120 HYPE limit @ 37.200", "Sell 0.5 BTC market". */
export function orderText(request: OrderRequest, base: string): string {
  const head =
    `${t(request.side === "buy" ? "side.buy" : "side.sell")} ${formatNumber(request.size)} ${base}`.trim();
  const kind =
    request.type === "market"
      ? t("toast.kindMarket")
      : request.type === "limit"
        ? t("toast.kindLimit", { price: formatNumber(request.price) })
        : t("toast.kindTrigger", { price: formatNumber(request.triggerPrice) });
  return `${head} ${kind}${request.reduceOnly ? ` · ${t("toast.reduceOnly")}` : ""}`;
}
