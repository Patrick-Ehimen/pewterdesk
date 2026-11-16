import type { Market, StrategyConfig, VenueId } from "@pewterdesk/core";
import { TokenIcon, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { venueClient } from "../../api/venueClient";
import { fullRules } from "../../lib/rules";
import { condText } from "./ruleText";

export const pct = (v: number, dp = 1, sign = true) =>
  `${sign ? (v >= 0 ? "+" : "−") : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(dp)}%`;

export const money = (v: number, sign = false, dp = 0) =>
  `${sign ? (v >= 0 ? "+" : "−") : v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;

export const price = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 1 : v >= 1 ? 3 : 6 });

export const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "dn" : undefined);

export const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
export const dayTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });

export function held(ms: number) {
  const h = Math.round(ms / 3_600_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`;
}

const Tok = ({ children }: { children: ReactNode }) => <span className="lab-tok">{children}</span>;

/** The strategy, read out as a sentence, its settings marked. */
export function Sentence({ config }: { config: StrategyConfig }) {
  switch (config.template) {
    case "ema":
      return (
        <>
          {t("bt.say.ema.go")} <Tok>{t(`bt.dir.${config.direction}`)}</Tok> {t("bt.say.ema.when")}{" "}
          <Tok>EMA {config.fast}</Tok> {t("bt.say.ema.crosses")} <Tok>EMA {config.slow}</Tok>.{" "}
          {t("bt.say.ema.out")} <Tok>{config.stopAtr}× ATR</Tok>. {t("bt.say.risk")}{" "}
          <Tok>{(config.risk * 100).toFixed(2).replace(/\.?0+$/, "")}%</Tok> {t("bt.say.riskOf")}{" "}
          <Tok>{config.maxLeverage}×</Tok> {t("bt.say.leverage")}
        </>
      );
    case "grid":
      return (
        <>
          {t("bt.say.grid.a")} <Tok>{config.levels}</Tok> {t("bt.say.grid.b")}{" "}
          <Tok>{price(config.lower)}</Tok> {t("bt.say.grid.c")} <Tok>{price(config.upper)}</Tok>,{" "}
          <Tok>{config.sizePerLevel}</Tok> {t("bt.say.grid.d")} <Tok>{price(config.stopBelow)}</Tok>{" "}
          / <Tok>{price(config.stopAbove)}</Tok>.
        </>
      );
    case "dca":
      return (
        <>
          {t("bt.say.dca.a")} <Tok>{money(config.amount)}</Tok> {t("bt.say.dca.b")}{" "}
          <Tok>{config.every}</Tok> {t("bt.say.dca.c")} <Tok>{config.maxBuys}</Tok>{" "}
          {t("bt.say.dca.d")} <Tok>{pct(config.takeProfit, 0, false)}</Tok> {t("bt.say.dca.e")}
        </>
      );
    case "custom": {
      const c = fullRules(config);
      const stop =
        c.stop ?? (c.stopLoss > 0 ? ({ kind: "fixed", pct: c.stopLoss } as const) : undefined);
      const sizing = c.sizing;
      const join = (all: boolean) => ` ${all ? t("bt.say.and") : t("bt.say.or")} `;
      return (
        <>
          {t("bt.say.custom.go")} <Tok>{t(`bt.dir.${c.side}`)}</Tok> {t("bt.say.custom.when")}{" "}
          {c.entry.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
            <span key={`e${i}`}>
              {i > 0 ? join(c.entryMatch === "all") : ""}
              <Tok>{condText(r)}</Tok>
            </span>
          ))}
          .{" "}
          {c.exit.length > 0 && (
            <>
              {t("bt.say.custom.out")}{" "}
              {c.exit.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; order is the identity
                <span key={`x${i}`}>
                  {i > 0 ? join(c.exitMatch === "all") : ""}
                  <Tok>{condText(r)}</Tok>
                </span>
              ))}
              .{" "}
            </>
          )}
          {stop && stop.kind !== "none" && (
            <>
              {t("bt.say.stop")}{" "}
              <Tok>
                {stop.kind === "fixed"
                  ? pct(stop.pct, 1, false)
                  : stop.kind === "atr"
                    ? `${stop.mult}× ATR`
                    : t("bt.say.swingLow", { n: stop.lookback })}
              </Tok>
              {c.targets.length > 0 ? (
                <>
                  , {t("bt.say.targets")} <Tok>{c.targets.map((x) => `${x.atR}R`).join(", ")}</Tok>
                </>
              ) : c.takeProfit > 0 ? (
                <>
                  , {t("bt.say.target")} <Tok>{pct(c.takeProfit, 1, false)}</Tok>
                </>
              ) : null}
              .{" "}
            </>
          )}
          {sizing?.kind === "risk" && (
            <>
              {t("bt.say.risk")} <Tok>{pct(sizing.risk, 2, false).replace(/\.?0+%$/, "%")}</Tok>{" "}
              {t("bt.say.riskOf")}
              {c.maxLeverage ? (
                <>
                  {" "}
                  <Tok>{c.maxLeverage}×</Tok> {t("bt.say.leverage")}
                </>
              ) : (
                "."
              )}
            </>
          )}
          {sizing && sizing.kind !== "risk" && <Tok>{t(`bt.sizing.${sizing.kind}`)}</Tok>}
        </>
      );
    }
  }
}

const marketsCache = new Map<VenueId, Promise<Market[]>>();
export function useVenueMarkets(venue: VenueId) {
  const [list, setList] = useState<Market[]>();
  useEffect(() => {
    let live = true;
    setList(undefined);
    let p = marketsCache.get(venue);
    if (!p) {
      p = venueClient.markets(venue);
      marketsCache.set(venue, p);
      p.catch(() => marketsCache.delete(venue));
    }
    p.then(
      (m) => live && setList(m),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [venue]);
  return list;
}

/** The market's name as the venue lists it, or its id until they load. */
export function marketName(markets: readonly Market[] | undefined, id: string) {
  return markets?.find((m) => m.id === id)?.symbol ?? id;
}

/** A market, picked by typing: the venue's list filtered as you go. */
export function MarketPicker({
  venue,
  value,
  onChange,
  list,
  compact,
  placeholder,
}: {
  venue: VenueId;
  value: string;
  onChange: (id: string) => void;
  /** The venue's markets when the caller has them already; fetched otherwise. */
  list?: readonly Market[];
  /** Just the name, as a word in a sentence. */
  compact?: boolean;
  /** Shown while no market is picked. */
  placeholder?: string;
}) {
  const fetched = useVenueMarkets(venue);
  const markets = list && list.length > 0 ? list : fetched;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const found = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = markets ?? [];
    return (
      q
        ? list.filter((m) => m.symbol.toUpperCase().includes(q) || m.id.toUpperCase().includes(q))
        : list
    ).slice(0, 40);
  }, [markets, query]);
  return (
    <div className="lab-picker" ref={rootRef}>
      <button
        type="button"
        className="lab-input lab-picker-button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="lab-picker-name">
          {value ? (
            <TokenIcon market={markets?.find((m) => m.id === value)} size={18} />
          ) : (
            <LuSearch size={14} aria-hidden />
          )}
          <b>{value ? marketName(markets, value) : (placeholder ?? "–")}</b>
        </span>
        {!compact && (
          <span className="lab-dim">
            {markets ? t("bt.builder.markets", { n: markets.length }) : t("bt.loading")}
          </span>
        )}
      </button>
      {open && (
        <div className="lab-picker-pop" role="listbox">
          <input
            // biome-ignore lint/a11y/noAutofocus: the list opens to be typed into
            autoFocus
            className="lab-picker-search"
            placeholder={t("bt.builder.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="lab-picker-list">
            {found.map((m) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={m.id === value}
                className={m.id === value ? "on" : undefined}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <TokenIcon market={m} size={18} />
                {m.symbol}
              </button>
            ))}
            {markets && found.length === 0 && <p className="lab-dim">{t("bt.builder.noMatch")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A number typed in a box, with a unit after it. */
export function NumField({
  label,
  value,
  onChange,
  unit,
  step,
  min,
  digits,
  blankZero,
  placeholder,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  /** Decimals to show (1.00, 2.0); typing keeps what's typed. */
  digits?: number;
  /** Shows 0 as an empty box (no limit), with `placeholder`. */
  blankZero?: boolean;
  placeholder?: string;
}) {
  const show = (v: number) =>
    blankZero && v === 0 ? "" : digits === undefined ? String(v) : v.toFixed(digits);
  const [text, setText] = useState(() => show(value));
  const last = useRef(value);
  if (last.current !== value) {
    last.current = value;
    if (Number(text) !== value) setText(show(value));
  }
  return (
    <label className="lab-field">
      <span>{label}</span>
      <span className="lab-input">
        <input
          inputMode="decimal"
          type="number"
          step={step}
          min={min}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() === "" && blankZero) onChange(0);
            else if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
          }}
          onBlur={() => text.trim() !== "" && setText(show(value))}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

/** A choice among a few, as one bar of buttons. */
export function Seg<V extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <fieldset className="lab-seg" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={o.value === value ? "on" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
