import type { CandleInterval } from "@pewterdesk/core";
import {
  ALL_INTERVALS,
  CHART_TYPES,
  type ChartType,
  INDICATORS,
  type IndicatorId,
} from "@pewterdesk/ui";

const STORAGE_KEY = "pd.chart.prefs";

/** How the candle chart is set up, remembered between sessions. */
export interface ChartPrefs {
  type: ChartType;
  /** In the order added, which is the order the readout lists them. */
  indicators: IndicatorId[];
  /** Intervals and chart styles with a toolbar button of their own. */
  favoriteIntervals: CandleInterval[];
  favoriteTypes: ChartType[];
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  type: "candles",
  indicators: ["volume"],
  favoriteIntervals: ["1m", "15m", "1h", "4h", "1d"],
  favoriteTypes: ["bars", "candles", "line"],
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** The known values in `raw`, once each, in their saved order. */
function known<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return [...new Set(raw.filter((v): v is T => allowed.includes(v as T)))];
}

export function loadChartPrefs(from: Storage | undefined = storage()): ChartPrefs {
  try {
    const saved: unknown = JSON.parse(from?.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return DEFAULT_CHART_PREFS;
    const s = saved as Record<string, unknown>;
    const type = CHART_TYPES.find((t) => t === s.type);
    return {
      type: type ?? DEFAULT_CHART_PREFS.type,
      indicators: known(s.indicators, INDICATORS) ?? DEFAULT_CHART_PREFS.indicators,
      favoriteIntervals:
        known(s.favoriteIntervals, ALL_INTERVALS) ?? DEFAULT_CHART_PREFS.favoriteIntervals,
      favoriteTypes: known(s.favoriteTypes, CHART_TYPES) ?? DEFAULT_CHART_PREFS.favoriteTypes,
    };
  } catch {
    return DEFAULT_CHART_PREFS;
  }
}

export function saveChartPrefs(prefs: ChartPrefs, to: Storage | undefined = storage()) {
  try {
    to?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable; the chart just won't remember its setup.
  }
}

/** `list` with `item` added at the end, or taken out if it's there. */
export function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Favorites stay in the menu's order, however they were picked. */
export function inOrder<T>(list: readonly T[], order: readonly T[]): T[] {
  return order.filter((x) => list.includes(x));
}

/**
 * Copies the chart image to the clipboard, or downloads it where the
 * clipboard won't take images. The clipboard write starts before the first
 * `await`, so it still counts as part of the click that asked for it
 * (WebKit refuses it otherwise).
 */
export async function exportChartImage(
  canvas: HTMLCanvasElement | undefined,
  fileName: string,
): Promise<"copied" | "saved" | "failed"> {
  if (!canvas) return "failed";
  const blob = new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"),
  );
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return "copied";
  } catch {
    try {
      const url = URL.createObjectURL(await blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return "saved";
    } catch {
      return "failed";
    }
  }
}
