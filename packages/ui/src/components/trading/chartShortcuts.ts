import {
  getDrawingTool,
  hasDrawingTool,
  type MagnetMode,
  registerDrawingTool,
} from "openalgo-charts/draw";
import type { Widget } from "openalgo-charts/widget";
import { t } from "../../i18n";

// Keyboard shortcuts for the chart's drawing tools, as TradingView has them
// where the chart's own keys leave room. The library gives five tools a
// chord (Alt+T trend line, Alt+H horizontal line, Alt+J horizontal ray,
// Alt+V vertical line, Alt+C cross line); these give more of them one the
// same way, so the widget binds them itself: in its "?" panel, rebindable
// there, and only while the pointer or the focus is on that chart. The
// magnet and "keep the tool armed" aren't tools, so they go on its keymap.

/**
 * More tools' chords. Alt+F is the chart's "fit all bars" and Alt+Shift+S
 * its screenshot, so the Fibonacci takes Alt+Shift+F and the short Alt+S.
 */
export const TOOL_SHORTCUTS: Readonly<Record<string, string>> = {
  "fib-retracement": "Shift+Alt+F",
  rectangle: "Shift+Alt+R",
  measure: "Alt+R",
  "long-position": "Alt+L",
  "short-position": "Alt+S",
  text: "Alt+N",
  brush: "Alt+B",
  highlighter: "Alt+G",
};

/** The drawing magnet's chord, and where the chart's crosshair magnet moves to make room. */
const MAGNET = "Alt+m";
const STAY = "Alt+k";
const CROSSHAIR_MAGNET = "chart:toggleCrosshairMagnet";
const CROSSHAIR_MAGNET_MOVED = ["Alt+Shift+KeyM"];
/** The group the library puts its tool chords in, so these sit beside them. */
const GROUP = "Drawing tools";

let registered = false;

/** Give the tools their chords; before a chart is made, so it binds them. */
export function registerToolShortcuts() {
  if (registered) return;
  registered = true;
  for (const [id, shortcut] of Object.entries(TOOL_SHORTCUTS)) {
    if (!hasDrawingTool(id)) continue;
    const tool = getDrawingTool(id);
    if (!tool.shortcut) registerDrawingTool({ ...tool, shortcut });
  }
}

/** The rail's magnet and armed switches: the library has no public way to them. */
interface Rail {
  cycleMagnet(): MagnetMode;
  stayMode(): boolean;
  setStayMode(on: boolean): void;
}

/** The magnet (off, weak, strong) and "keep the tool armed", on this chart's keys. */
export function attachChartShortcuts(widget: Widget): () => void {
  const { keymap } = widget.context;
  const rail = () => (widget as unknown as { _rail?: Rail | null })._rail ?? undefined;
  // The chart's crosshair magnet had Alt+M: it moves along, unless the
  // trader gave it a chord of their own.
  if (keymap.chord(CROSSHAIR_MAGNET) === MAGNET) {
    keymap.rebind(CROSSHAIR_MAGNET, CROSSHAIR_MAGNET_MOVED);
  }
  const off = [
    keymap.register(
      MAGNET,
      () => {
        const r = rail();
        if (!r) return false;
        const mode = r.cycleMagnet();
        widget.context.toast(t(`chart.magnet.${mode}`));
      },
      "widget",
      { label: t("chart.key.magnet"), group: GROUP, command: "magnet" },
    ),
    keymap.register(
      STAY,
      () => {
        const r = rail();
        if (!r) return false;
        const on = !r.stayMode();
        r.setStayMode(on);
        widget.context.toast(t(on ? "chart.stay.on" : "chart.stay.off"));
      },
      "widget",
      { label: t("chart.key.stay"), group: GROUP, command: "stay" },
    ),
  ];
  return () => {
    for (const stop of off) stop();
  };
}
