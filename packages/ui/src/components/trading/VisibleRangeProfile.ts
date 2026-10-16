import {
  type IndicatorApi,
  type IndicatorSettings,
  type IPrimitive,
  type PrimitiveHost,
  type PrimitiveRenderContext,
  registerIndicator,
} from "openalgo-charts";
import { t as tr } from "../../i18n";
import { type ProfileRow, type VolumeProfile, volumeProfile } from "../../lib/volumeProfile";
import { withAlpha } from "./chartTheme";

// The visible range volume profile (VPVR), as TradingView draws it: volume
// at price over the bars on screen, as a histogram along the plot's edge,
// recomputed as the chart pans and zooms. It is a study (in the picker,
// the readout and the kept layout) with no plots of its own: the chart
// gives each one a primitive (`syncProfiles`), which reads the study's
// settings and visibility as it draws. A primitive the study attached
// itself would not hide with it.

export const VPVR_ID = "vpvr";

/** How solid a row is inside the value area, and outside it. */
const VALUE_ALPHA = 0.42;
const OUTSIDE_ALPHA = 0.18;

interface ProfileSettings {
  rows: number;
  valueArea: number;
  width: number;
  side: "left" | "right";
  upDown: boolean;
  showPoc: boolean;
}

const DEFAULTS: ProfileSettings = {
  rows: 24,
  valueArea: 70,
  width: 30,
  side: "right",
  upDown: true,
  showPoc: true,
};

function profileSettings(s: IndicatorSettings): ProfileSettings {
  const num = (key: keyof ProfileSettings, fallback: number) =>
    typeof s[key] === "number" && Number.isFinite(s[key]) ? (s[key] as number) : fallback;
  const bool = (key: keyof ProfileSettings, fallback: boolean) =>
    typeof s[key] === "boolean" ? (s[key] as boolean) : fallback;
  return {
    rows: Math.min(200, Math.max(4, Math.round(num("rows", DEFAULTS.rows)))),
    valueArea: Math.min(100, Math.max(1, num("valueArea", DEFAULTS.valueArea))),
    width: Math.min(80, Math.max(5, num("width", DEFAULTS.width))),
    side: s.side === "left" ? "left" : "right",
    upDown: bool("upDown", DEFAULTS.upDown),
    showPoc: bool("showPoc", DEFAULTS.showPoc),
  };
}

let registered = false;

/**
 * Puts the study in the picker. Called when a chart is made, not at module
 * scope: its names are in the session's language, which loads first.
 */
export function registerVisibleRangeProfile() {
  if (registered) return;
  registered = true;
  registerIndicator({
    id: VPVR_ID,
    name: tr("indicator.vpvr"),
    category: "Volume",
    placement: "onchart",
    inputs: [
      {
        key: "rows",
        type: "number",
        label: tr("indicator.vpvr.rows"),
        default: DEFAULTS.rows,
        min: 4,
        max: 200,
        step: 1,
      },
      {
        key: "valueArea",
        type: "number",
        label: tr("indicator.vpvr.valueArea"),
        default: DEFAULTS.valueArea,
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: "width",
        type: "number",
        label: tr("indicator.vpvr.width"),
        default: DEFAULTS.width,
        min: 5,
        max: 80,
        step: 5,
      },
      {
        key: "side",
        type: "select",
        label: tr("indicator.vpvr.side"),
        default: DEFAULTS.side,
        options: [
          { label: tr("indicator.vpvr.right"), value: "right" },
          { label: tr("indicator.vpvr.left"), value: "left" },
        ],
      },
      {
        key: "upDown",
        type: "boolean",
        label: tr("indicator.vpvr.upDown"),
        default: DEFAULTS.upDown,
      },
      {
        key: "showPoc",
        type: "boolean",
        label: tr("indicator.vpvr.poc"),
        default: DEFAULTS.showPoc,
      },
    ],
    plots: [],
    calc: () => ({}),
  });
}

/** One study's histogram, drawn behind the candles of the pane it is on. */
class ProfilePrimitive implements IPrimitive {
  study: IndicatorApi;
  readonly pane: number;
  private host: PrimitiveHost | null = null;
  /** What the profile was last worked out from, so a still chart reuses it. */
  private key = "";
  private profile: VolumeProfile | undefined;

  constructor(study: IndicatorApi) {
    this.study = study;
    this.pane = study.paneIndex;
  }

  attached(host: PrimitiveHost) {
    this.host = host;
  }
  detached() {
    this.host = null;
  }
  zOrder() {
    return "bottom" as const;
  }
  refresh() {
    this.host?.requestUpdate();
  }

  /** The row drawn at `price`, or the point of control's without one (or off the profile). */
  rowAt(price?: number | null): ProfileRow | undefined {
    const profile = this.profile;
    if (!profile || !this.study.visible()) return undefined;
    const { rows } = profile;
    const at =
      price === undefined || price === null
        ? undefined
        : rows.find((row, i) => price >= row.low && (price < row.high || i === rows.length - 1));
    return at ?? rows[profile.poc];
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext) {
    if (!this.study.visible()) return;
    const s = profileSettings(this.study.settings());
    const bars = rc.bars?.() ?? [];
    const { from, to } = rc.timeScale.visibleRange();
    const first = Math.max(0, Math.ceil(from));
    const last = Math.min(bars.length - 1, Math.floor(to));
    const start = bars[first];
    const end = bars[last];
    if (!start || !end || last < first) return;
    const key = [
      first,
      last,
      bars.length,
      start.time,
      end.time,
      end.close,
      end.volume,
      s.rows,
      s.valueArea,
    ].join("|");
    if (key !== this.key) {
      this.key = key;
      this.profile = volumeProfile(bars.slice(first, last + 1), s.rows, s.valueArea / 100);
    }
    const profile = this.profile;
    if (!profile || profile.max <= 0) return;

    const { dpr, theme } = rc;
    const y = (price: number) => rc.priceScale.priceToY(price) * dpr;
    const full = rc.plotWidth * dpr;
    const length = (full * s.width) / 100;
    const right = s.side === "right";
    ctx.save();
    profile.rows.forEach((row, i) => {
      const top = Math.round(y(row.high));
      const height = Math.max(1, Math.round(y(row.low)) - top - 1);
      const alpha = i >= profile.valueLow && i <= profile.valueHigh ? VALUE_ALPHA : OUTSIDE_ALPHA;
      const parts = s.upDown
        ? [
            { size: row.up, color: theme.upColor },
            { size: row.down, color: theme.downColor },
          ]
        : [{ size: row.up + row.down, color: theme.axisText }];
      let x = right ? full : 0;
      for (const part of parts) {
        const w = (part.size / profile.max) * length;
        if (w <= 0) continue;
        ctx.fillStyle = withAlpha(part.color, alpha);
        ctx.fillRect(right ? x - w : x, top, w, height);
        x = right ? x - w : x + w;
      }
    });
    const poc = profile.rows[profile.poc];
    if (s.showPoc && poc) {
      const at = Math.round(y((poc.low + poc.high) / 2)) + 0.5;
      ctx.strokeStyle = theme.lineColor;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath();
      ctx.moveTo(0, at);
      ctx.lineTo(full, at);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** The profiles a chart draws, by study id. */
export type Profiles = Map<string, ProfilePrimitive>;

interface ProfileChart {
  indicators(): readonly IndicatorApi[];
  addPrimitive(primitive: IPrimitive, paneIndex?: number): void;
  removePrimitive(primitive: IPrimitive): void;
}

/**
 * Gives each profile study on the chart its primitive, takes away those of
 * studies gone, and redraws the rest (their settings or visibility may have
 * changed).
 */
export function syncProfiles(chart: ProfileChart, profiles: Profiles) {
  const wanted = new Set<string>();
  for (const study of chart.indicators()) {
    if (study.indicatorId !== VPVR_ID) continue;
    wanted.add(study.id);
    let had = profiles.get(study.id);
    if (had && had.pane !== study.paneIndex) {
      chart.removePrimitive(had);
      had = undefined;
    }
    if (!had) {
      had = new ProfilePrimitive(study);
      profiles.set(study.id, had);
      chart.addPrimitive(had, study.paneIndex);
    }
    had.study = study;
    had.refresh();
  }
  for (const [id, had] of profiles) {
    if (wanted.has(id)) continue;
    chart.removePrimitive(had);
    profiles.delete(id);
  }
}
