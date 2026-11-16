import type { Market, VenueId } from "@pewterdesk/core";
import { TokenIcon, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  LuArrowRight,
  LuChartNoAxesCombined,
  LuLayers,
  LuListChecks,
  LuPlay,
  LuTrendingUp,
} from "react-icons/lu";
import { type LabStrategy, newId, TEMPLATES, type Template } from "../../lib/backtestLab";
import { VENUES } from "../../lib/venues";
import { defaultConfig } from "./BuilderView";
import { MarketPicker } from "./parts";

const ICON: Record<Template, ReactNode> = {
  ema: <LuTrendingUp size={20} aria-hidden />,
  grid: <LuLayers size={20} aria-hidden />,
  dca: <LuChartNoAxesCombined size={20} aria-hidden />,
  custom: <LuListChecks size={20} aria-hidden />,
};

/** The coins a trader is likeliest to start on, as the venue lists them. */
const FAVOURITES = ["BTC", "ETH", "SOL", "HYPE", "XRP"];

/** Ready-made strategies to try on any market: each a template with sensible settings. */
const PRESETS = ["trend", "twoWay", "grid", "rsi"] as const;
type Preset = (typeof PRESETS)[number];

/**
 * A small drawing of what each kind of strategy does - a picture of the
 * idea, like an icon, not a chart of any data.
 */
function Art({ preset }: { preset: Preset }) {
  const line = (pts: number[]) =>
    pts.map((y, i) => `${((i / (pts.length - 1)) * 200).toFixed(1)},${y}`).join(" ");
  const trend = [
    38, 40, 36, 39, 35, 37, 33, 34, 30, 31, 26, 28, 23, 24, 19, 21, 16, 17, 13, 14, 11,
  ];
  const both = [12, 14, 13, 17, 16, 21, 24, 23, 28, 32, 34, 33, 30, 27, 24, 22, 19, 16, 15, 12, 13];
  const range = [
    26, 18, 14, 20, 30, 36, 31, 22, 15, 19, 28, 35, 33, 24, 16, 14, 21, 30, 36, 30, 22,
  ];
  const rsi = [16, 22, 30, 36, 40, 37, 31, 26, 21, 17, 14, 18, 25, 33, 38, 34, 28, 22, 17, 13, 11];
  const pts = { trend, twoWay: both, grid: range, rsi }[preset];
  return (
    <svg className="lab-art" viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true">
      {preset === "grid" &&
        [12, 20, 28, 36].map((y) => (
          <line key={y} className="lab-art-level" x1="0" x2="200" y1={y} y2={y} />
        ))}
      {preset === "rsi" && <line className="lab-art-level" x1="0" x2="200" y1="34" y2="34" />}
      <polyline className="lab-art-line" points={line(pts)} />
      {preset === "trend" && <path className="lab-art-buy" d="M50 44 l4 -7 h-8z" />}
      {preset === "twoWay" && (
        <>
          <path className="lab-art-buy" d="M10 22 l4 -7 h-8z" />
          <path className="lab-art-sell" d="M115 24 l4 7 h-8z" />
        </>
      )}
      {preset === "rsi" && (
        <>
          <circle className="lab-art-buy-dot" cx="100" cy="14" r="2.8" />
          <circle className="lab-art-buy-dot" cx="10" cy="22" r="2.8" />
        </>
      )}
      {preset === "grid" &&
        [30, 80, 130, 175].map((x) => (
          <circle key={x} className="lab-art-dot" cx={x} cy={x % 100 === 30 ? 28 : 20} r="2.2" />
        ))}
    </svg>
  );
}

function presetSettings(
  preset: Preset,
  price: number | undefined,
): Pick<LabStrategy, "interval" | "period" | "holdOutDays" | "strategy"> | undefined {
  switch (preset) {
    case "trend":
      return {
        interval: "4h",
        period: "1y",
        holdOutDays: 60,
        strategy: {
          template: "ema",
          fast: 9,
          slow: 21,
          stopAtr: 2,
          risk: 0.01,
          maxLeverage: 3,
          direction: "long",
        },
      };
    case "twoWay":
      return {
        interval: "4h",
        period: "1y",
        holdOutDays: 60,
        strategy: {
          template: "ema",
          fast: 20,
          slow: 50,
          stopAtr: 2.5,
          risk: 0.01,
          maxLeverage: 3,
          direction: "both",
        },
      };
    case "grid":
      // A grid is set around today's price: without one it can't be placed.
      return price
        ? { interval: "1h", period: "90d", holdOutDays: 14, strategy: defaultConfig("grid", price) }
        : undefined;
    case "rsi":
      return {
        interval: "1h",
        period: "180d",
        holdOutDays: 30,
        strategy: {
          template: "custom",
          side: "long",
          entry: [
            {
              left: { kind: "rsi", period: 14 },
              op: "crossesAbove",
              right: { kind: "value", value: 30 },
            },
            { left: { kind: "price" }, op: "above", right: { kind: "ema", period: 200 } },
          ],
          exit: [
            {
              left: { kind: "rsi", period: 14 },
              op: "crossesAbove",
              right: { kind: "value", value: 70 },
            },
          ],
          stopLoss: 0.03,
          takeProfit: 0.05,
          size: 1,
        },
      };
  }
}

/**
 * Where a strategy starts: a market, then a ready-made strategy to run at
 * once, or a kind of trade to set up in the builder. The empty library,
 * and "New strategy".
 */
export function StartView({
  venue,
  markets,
  priceOf,
  hasStrategies,
  onRun,
  onBuild,
  onBack,
}: {
  venue: VenueId;
  markets: readonly Market[];
  priceOf: (venue: VenueId, market: string) => number | undefined;
  hasStrategies: boolean;
  /** Saves it and runs it now. */
  onRun: (s: LabStrategy) => void;
  /** Saves nothing yet: opens it in the builder. */
  onBuild: (s: LabStrategy) => void;
  onBack: () => void;
}) {
  const favourites = useMemo(
    () =>
      FAVOURITES.flatMap((base) => {
        const m = markets.find(
          (x) => x.base.toUpperCase() === base && x.quote.toUpperCase().startsWith("US"),
        );
        return m ? [m] : [];
      }),
    [markets],
  );
  // The trader's pick, else the first favourite once the venue's list is in.
  const [picked, setPicked] = useState<string>();
  const market = picked ?? favourites[0]?.id ?? markets[0]?.id ?? "";
  const name = markets.find((m) => m.id === market)?.symbol ?? market;
  const price = market ? priceOf(venue, market) : undefined;
  const otherPicked = market !== "" && !favourites.some((m) => m.id === market);
  const [preset, setPreset] = useState<Preset>("trend");
  const chosen = presetSettings(preset, price);
  const chosenLabel = t(`bt.start.preset.${preset}`);
  // ⌘↵ runs the one picked, as the builder's Run does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && market && chosen) {
        e.preventDefault();
        onRun(make(chosenLabel, chosen));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const make = (
    label: string,
    settings: Pick<LabStrategy, "interval" | "period" | "holdOutDays" | "strategy">,
  ): LabStrategy => ({
    id: newId(),
    name: label,
    active: true,
    venue,
    market,
    capital: 10_000,
    slippageBps: 5,
    version: 1,
    updatedAt: Date.now(),
    ...settings,
  });
  const fromTemplate = (tpl: Template): LabStrategy =>
    make(t(`bt.tpl.${tpl}`), {
      interval: "4h",
      period: "1y",
      holdOutDays: 60,
      strategy: defaultConfig(tpl, price ?? 100),
    });

  return (
    <div className="lab-start">
      <section className="lab-panel lab-start-main">
        <div className="lab-start-head">
          <div>
            <h2>{t("bt.start.title")}</h2>
            <p>{t("bt.start.lead")}</p>
          </div>
          {hasStrategies && (
            <button type="button" className="lab-btn ghost" onClick={onBack}>
              {t("bt.start.back")}
            </button>
          )}
        </div>

        <div>
          <span className="lab-label">{t("bt.start.markets", { venue: VENUES[venue].label })}</span>
          <div className="lab-mkts">
            {favourites.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`lab-mk${m.id === market ? " on" : ""}`}
                aria-pressed={m.id === market}
                onClick={() => setPicked(m.id)}
              >
                <TokenIcon market={m} size={20} />
                {m.symbol}
              </button>
            ))}
            <span className={`lab-mk-other${otherPicked ? " on" : ""}`}>
              <MarketPicker
                venue={venue}
                value={otherPicked ? market : ""}
                onChange={setPicked}
                list={markets}
                compact
                placeholder={t("bt.start.otherMarket")}
              />
            </span>
          </div>
        </div>

        <div className="lab-hero">
          <span className="lab-label">{t("bt.start.try", { market: name || "–" })}</span>
          <div className="lab-presets">
            {PRESETS.map((p) => {
              const settings = presetSettings(p, price);
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={preset === p}
                  className={`lab-preset${preset === p ? " on" : ""}`}
                  disabled={!settings}
                  onClick={() => setPreset(p)}
                >
                  <Art preset={p} />
                  <b>{t(`bt.start.preset.${p}`)}</b>
                  <p>{t(`bt.start.preset.${p}Body`)}</p>
                  <span className="lab-dim">
                    {settings
                      ? `${settings.interval} · ${t(`bt.period.${settings.period}`)}`
                      : t("bt.start.needsPrice")}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="lab-go">
            <button
              type="button"
              className="lab-btn primary big"
              disabled={!market || !chosen}
              onClick={() => chosen && onRun(make(chosenLabel, chosen))}
            >
              <LuPlay size={14} aria-hidden />
              {t("bt.start.runPreset", { preset: chosenLabel, market: name || "–" })}
              <span className="lab-kbd">⌘↵</span>
            </button>
            <button
              type="button"
              className="lab-btn big"
              disabled={!market || !chosen}
              onClick={() => chosen && onBuild(make(chosenLabel, chosen))}
            >
              {t("bt.start.edit")}
            </button>
            <span className="lab-dim">
              {chosen
                ? t("bt.start.runNote", {
                    interval: chosen.interval,
                    period: t(`bt.period.${chosen.period}`),
                    n: chosen.holdOutDays,
                  })
                : ""}
            </span>
          </div>
        </div>

        <div>
          <span className="lab-label">{t("bt.start.kinds")}</span>
          <div className="lab-build">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl}
                type="button"
                className="lab-build-btn"
                disabled={!market}
                onClick={() => onBuild(fromTemplate(tpl))}
              >
                <span className="lab-tpl-icon small">{ICON[tpl]}</span>
                <span>
                  <b>{t(`bt.start.kind.${tpl}`)}</b>
                  <small>{t(`bt.start.kind.${tpl}For`)}</small>
                </span>
                <LuArrowRight size={14} aria-hidden />
              </button>
            ))}
          </div>
          <p className="lab-dim lab-start-after">{t("bt.start.after")}</p>
        </div>
      </section>

      <aside className="lab-panel lab-habits">
        <div className="lab-ph">
          <h2>{t("bt.start.habits")}</h2>
        </div>
        {(["holdOut", "costs", "hold"] as const).map((k, i) => (
          <div key={k} className="lab-habit">
            <span className="lab-habit-n">{i + 1}</span>
            <div>
              <b>{t(`bt.start.habit.${k}`)}</b>
              <p>{t(`bt.start.habit.${k}Body`)}</p>
            </div>
          </div>
        ))}
        <p className="lab-note lab-habits-note">{t("bt.start.engine")}</p>
      </aside>
    </div>
  );
}
