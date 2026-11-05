import type { Market, MarketSummary } from "@pewterdesk/core";
import { dateFormat, formatNumber, formatPercent, TokenIcon, t, trendClass } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import {
  LuArrowDownRight,
  LuArrowRight,
  LuArrowUpRight,
  LuCheck,
  LuChevronDown,
  LuPlus,
  LuStar,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import {
  type Bias,
  type DayBias,
  type DayLevel,
  LEVEL_KINDS,
  type LevelKind,
  levelsText,
} from "../../lib/journal";
import { ConfirmButton, hueOf, marketHue } from "./parts";

// Today's watchlist: a card per pair, and the editor it opens. What a card
// holds is the day entry's own market (`DayBias`), so the journal's day page
// reads the same bias, levels, thesis and conviction.

const BIASES: readonly Bias[] = ["long", "short", "neutral"];
const BIAS_ICON = { long: LuArrowUpRight, short: LuArrowDownRight, neutral: LuArrowRight } as const;
const ADDED: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
};

const levelLabel = (kind: LevelKind) => t(`plan.level.${kind}` as const);

/** The day's change, from the venue's summary. */
function dayChange(summary: MarketSummary | undefined): number | undefined {
  if (!summary) return undefined;
  const now = Number(summary.markPrice);
  const then = Number(summary.prevDayPrice);
  return then > 0 && Number.isFinite(now) ? now / then - 1 : undefined;
}

/** The levels a card shows: the list where there is one, else the line typed before it. */
function levelsOf(value: DayBias): DayLevel[] {
  if (value.levelList?.length) return value.levelList.filter((l) => l.price.trim());
  return value.levels.trim() ? [{ kind: "level", price: value.levels.trim(), note: "" }] : [];
}

function Badge({ market, symbol, size }: { market?: Market; symbol: string; size: number }) {
  return market ? (
    <span className="jr-wcard-logo" style={{ width: size, height: size }}>
      <TokenIcon market={market} size={size} />
    </span>
  ) : (
    <span
      className="jr-wcard-logo"
      data-initial=""
      style={{ width: size, height: size }}
      aria-hidden
    >
      {symbol
        .replace(/^[^A-Za-z0-9]+/, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

function Price({ summary }: { summary: MarketSummary | undefined }) {
  if (!summary) return null;
  const change = dayChange(summary);
  return (
    <span className="jr-wcard-price">
      <strong className="pd-num">{formatNumber(summary.markPrice)}</strong>
      {change !== undefined && (
        <span className={`pd-num ${trendClass(change)}`}>
          {t("plan.watch.change24", {
            pct: `${change > 0 ? "+" : ""}${formatPercent(change)}`,
          })}
        </span>
      )}
    </span>
  );
}

function BiasPill({ bias }: { bias: Bias }) {
  return (
    <span className="jr-biaspill" data-bias={bias}>
      {t("plan.today.biasPill", { bias: t(`plan.bias.${bias}` as const) })}
    </span>
  );
}

function Stars({
  value,
  onChange,
  disabled,
  label,
  size = 15,
}: {
  value: number;
  onChange?: (value: number | undefined) => void;
  disabled?: boolean;
  label: string;
  size?: number;
}) {
  if (!onChange)
    return (
      <span className="jr-watchstars" role="img" aria-label={`${label}: ${value || "-"} / 5`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <LuStar key={n} size={size} data-on={n <= value ? "" : undefined} aria-hidden />
        ))}
      </span>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggles, like the page's other segmented choices
    <span className="jr-watchstars" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={n <= value}
          aria-label={`${n} / 5`}
          data-on={n <= value ? "" : undefined}
          disabled={disabled}
          onClick={() => onChange(value === n ? undefined : n)}
        >
          <LuStar size={size} aria-hidden />
        </button>
      ))}
    </span>
  );
}

/** One pair on today's watchlist, at a glance; a click opens its editor. */
export function WatchCard({
  symbol,
  marketId,
  market,
  summary,
  value,
  disabled,
  onOpen,
  onRemove,
}: {
  symbol: string;
  marketId: string;
  market?: Market;
  summary?: MarketSummary;
  value: DayBias;
  disabled?: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const levels = levelsOf(value);
  const shown = levels.slice(0, 3);
  return (
    <article className="jr-wcard" data-bias={value.bias} style={hueOf(marketHue(marketId))}>
      <button
        type="button"
        className="jr-wcard-main"
        aria-label={t("plan.watch.edit", { market: symbol })}
        onClick={onOpen}
      >
        <span className="jr-wcard-head">
          <Badge market={market} symbol={symbol} size={40} />
          <span className="jr-wcard-title">
            <span className="jr-wcard-name">
              <strong>{symbol}</strong>
              <BiasPill bias={value.bias} />
            </span>
            {value.addedAt !== undefined && (
              <span className="jr-wcard-sub pd-num">
                {t("plan.watch.added", { when: `${dateFormat(ADDED).format(value.addedAt)} UTC` })}
              </span>
            )}
          </span>
          <Price summary={summary} />
        </span>

        <span className="jr-wcard-thesis">
          {value.note.trim() ? (
            <>
              <strong>{t("plan.watch.thesis")}</strong> {value.note}
            </>
          ) : (
            <span className="jr-muted">{t("plan.watch.noThesis")}</span>
          )}
        </span>

        <span className="jr-wcard-foot">
          <span className="jr-wcard-levels">
            <span className="jr-muted">{t("plan.watch.keyLevels")}</span>
            {shown.length ? (
              shown.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: levels have no identity but their place
                <span key={i} className="jr-levelchip" data-kind={l.kind}>
                  {(l.label || l.kind !== "level") && <em>{l.label || levelLabel(l.kind)}</em>}
                  <span className="pd-num">{l.price}</span>
                </span>
              ))
            ) : (
              <span className="jr-muted">-</span>
            )}
            {levels.length > shown.length && (
              <span className="jr-muted pd-num">
                {t("plan.watch.more", { n: levels.length - shown.length })}
              </span>
            )}
          </span>
          <Stars value={value.conviction ?? 0} label={t("plan.today.conviction")} size={14} />
        </span>
      </button>
      {!disabled && (
        <ConfirmButton
          className="jr-icon jr-wcard-x"
          label={t("plan.today.unwatch", { market: symbol })}
          title={t("plan.confirm.pairTitle", { market: symbol })}
          body={t("plan.confirm.pairBody")}
          action={t("plan.confirm.remove")}
          danger
          onConfirm={onRemove}
        >
          <LuX size={14} aria-hidden />
        </ConfirmButton>
      )}
    </article>
  );
}

/**
 * A level's kind, as our own menu: the six kinds, each in its colour, and a
 * name of the trader's own ("Weekly open", "VWAP") typed at the foot.
 */
function KindPicker({
  level,
  n,
  disabled,
  onChange,
}: {
  level: DayLevel;
  n: number;
  disabled?: boolean;
  onChange: (change: Partial<DayLevel>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const shown = level.label || levelLabel(level.kind);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the menu, not the dialog around it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  const pick = (kind: LevelKind) => {
    onChange({ kind, label: undefined });
    setOpen(false);
  };
  const name = () => {
    const label = custom.trim().slice(0, 40);
    if (!label) return;
    onChange({ kind: "level", label });
    setCustom("");
    setOpen(false);
  };

  return (
    <div ref={box} className="jr-kindpick" data-kind={level.label ? "level" : level.kind}>
      <button
        type="button"
        className="jr-kindpick-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("plan.watch.kindFor", { n })}
        disabled={disabled}
        onClick={() => {
          setCustom(level.label ?? "");
          setOpen((o) => !o);
        }}
      >
        <span className="jr-kindpick-dot" aria-hidden />
        <span className="jr-kindpick-name">{shown}</span>
        <LuChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="jr-kindpick-menu">
          <div role="listbox" aria-label={t("plan.watch.kindFor", { n })}>
            {LEVEL_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="option"
                aria-selected={!level.label && level.kind === k}
                data-kind={k}
                className="jr-kindpick-opt"
                onClick={() => pick(k)}
              >
                <span className="jr-kindpick-dot" aria-hidden />
                {levelLabel(k)}
                {!level.label && level.kind === k && <LuCheck size={13} aria-hidden />}
              </button>
            ))}
          </div>
          <div className="jr-kindpick-custom">
            <span className="jr-label">{t("plan.watch.customKind")}</span>
            <div className="jr-kindpick-customrow">
              <input
                className="pd-input"
                value={custom}
                maxLength={40}
                // biome-ignore lint/a11y/noAutofocus: the menu was opened to type in it or pick
                autoFocus={Boolean(level.label)}
                placeholder={t("plan.watch.customKindPh")}
                aria-label={t("plan.watch.customKind")}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    name();
                  }
                }}
              />
              <button type="button" className="jr-button" disabled={!custom.trim()} onClick={name}>
                {t("plan.watch.useName")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const blankLevel = (kind: LevelKind = "support"): DayLevel => ({ kind, price: "", note: "" });

/**
 * A watched pair's editor: bias, conviction, its key levels one by one, and
 * the thesis. Changes stay here until Save; Cancel, Escape or a click outside
 * drops them.
 */
export function WatchEditor({
  open,
  symbol,
  marketId,
  market,
  summary,
  value,
  disabled,
  onSave,
  onRemove,
  onClose,
}: {
  open: boolean;
  symbol: string;
  marketId: string;
  market?: Market;
  summary?: MarketSummary;
  value: DayBias;
  disabled?: boolean;
  onSave: (change: Partial<DayBias>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [bias, setBias] = useState<Bias>(value.bias);
  const [conviction, setConviction] = useState<number | undefined>(value.conviction);
  const [note, setNote] = useState(value.note);
  const [levels, setLevels] = useState<DayLevel[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the draft starts again only when it opens
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setBias(value.bias);
      setConviction(value.conviction);
      setNote(value.note);
      const list = levelsOf(value);
      setLevels(
        list.length
          ? list.map((l) => ({ ...l }))
          : [blankLevel("support"), blankLevel("resistance")],
      );
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  const setLevel = (i: number, change: Partial<DayLevel>) =>
    setLevels((list) => list.map((l, j) => (j === i ? { ...l, ...change } : l)));

  const save = () => {
    const kept = levels
      .map((l) => ({
        kind: l.kind,
        ...(l.label?.trim() && { label: l.label.trim() }),
        price: l.price.trim(),
        note: l.note.trim(),
      }))
      .filter((l) => l.price);
    onSave({
      bias,
      conviction,
      note: note.trim(),
      levelList: kept.length ? kept : undefined,
      levels: levelsText(kept, levelLabel),
    });
    onClose();
  };

  const titleId = `jr-watch-${marketId}`;
  return (
    <dialog
      ref={ref}
      className="jr-dialog jr-watchedit"
      aria-labelledby={titleId}
      style={hueOf(marketHue(marketId))}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !disabled) {
          e.preventDefault();
          save();
        }
      }}
    >
      <header className="jr-watchedit-head">
        <Badge market={market} symbol={symbol} size={44} />
        <div className="jr-watchedit-title">
          <span className="jr-wcard-name">
            <strong id={titleId}>{symbol}</strong>
            <BiasPill bias={bias} />
          </span>
          <span className="jr-muted">
            {disabled ? t("plan.watch.locked") : t("plan.watch.editLead")}
          </span>
        </div>
        <Price summary={summary} />
        <button
          type="button"
          className="jr-icon"
          aria-label={t("plan.watch.close")}
          onClick={onClose}
        >
          <LuX size={16} aria-hidden />
        </button>
      </header>

      <div className="jr-dialog-body jr-watchedit-body">
        <div className="jr-watchedit-col">
          <section className="jr-watchedit-sec">
            <h3 className="jr-label">1 · {t("plan.watch.bias")}</h3>
            {/* biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the page's others */}
            <div
              className="jr-biaspick jr-biaspick-lg"
              role="group"
              aria-label={t("plan.watch.bias")}
            >
              {BIASES.map((b) => {
                const Icon = BIAS_ICON[b];
                return (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={bias === b}
                    data-bias={b}
                    disabled={disabled}
                    onClick={() => setBias(b)}
                  >
                    <Icon size={16} aria-hidden />
                    {t(`plan.bias.${b}` as const)}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="jr-watchedit-sec">
            <h3 className="jr-label">2 · {t("plan.watch.conviction")}</h3>
            <div className="jr-watchedit-stars">
              <Stars
                value={conviction ?? 0}
                onChange={setConviction}
                disabled={disabled}
                label={t("plan.watch.conviction")}
                size={22}
              />
              <span className="jr-muted pd-num">{conviction ? `${conviction}/5` : "-"}</span>
            </div>
          </section>

          <section className="jr-watchedit-sec">
            <h3 className="jr-label">3 · {t("plan.watch.thesisLabel")}</h3>
            <textarea
              className="pd-input jr-watchedit-thesis"
              rows={5}
              maxLength={2000}
              value={note}
              disabled={disabled}
              placeholder={t("plan.watch.thesisPh")}
              aria-label={t("plan.watch.thesisLabel")}
              onChange={(e) => setNote(e.target.value)}
            />
          </section>
        </div>

        <div className="jr-watchedit-col">
          <section className="jr-watchedit-sec">
            <h3 className="jr-label">4 · {t("plan.watch.levels")}</h3>
            <p className="jr-hint">{t("plan.watch.levelsHint")}</p>
            <div className="jr-levelrows">
              {levels.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: levels have no identity but their place
                <div key={i} className="jr-levelrow" data-kind={l.kind}>
                  <KindPicker
                    level={l}
                    n={i + 1}
                    disabled={disabled}
                    onChange={(change) => setLevel(i, change)}
                  />
                  <input
                    className="pd-input pd-num"
                    inputMode="decimal"
                    value={l.price}
                    disabled={disabled}
                    placeholder={t("plan.watch.price")}
                    aria-label={t("plan.watch.priceFor", { n: i + 1 })}
                    onChange={(e) => setLevel(i, { price: e.target.value })}
                  />
                  <input
                    className="pd-input"
                    maxLength={120}
                    value={l.note}
                    disabled={disabled}
                    placeholder={t("plan.watch.levelNote")}
                    aria-label={t("plan.watch.noteFor", { n: i + 1 })}
                    onChange={(e) => setLevel(i, { note: e.target.value })}
                  />
                  {!disabled && (
                    <button
                      type="button"
                      className="jr-icon"
                      aria-label={t("plan.watch.removeLevel", { n: i + 1 })}
                      onClick={() => setLevels((list) => list.filter((_, j) => j !== i))}
                    >
                      <LuX size={13} aria-hidden />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!disabled && levels.length < 12 && (
              <button
                type="button"
                className="jr-watchedit-addlevel"
                onClick={() => setLevels((list) => [...list, blankLevel("level")])}
              >
                <LuPlus size={13} aria-hidden /> {t("plan.watch.addLevel")}
              </button>
            )}
          </section>
        </div>
      </div>

      <footer className="jr-dialog-foot jr-watchedit-foot">
        {!disabled && (
          <ConfirmButton
            className="jr-button jr-quiet jr-watchedit-remove"
            title={t("plan.confirm.pairTitle", { market: symbol })}
            body={t("plan.confirm.pairBody")}
            action={t("plan.confirm.remove")}
            danger
            onConfirm={() => {
              onRemove();
              onClose();
            }}
          >
            <LuTrash2 size={13} aria-hidden /> {t("plan.watch.remove")}
          </ConfirmButton>
        )}
        <button type="button" className="jr-button" onClick={onClose}>
          {disabled ? t("plan.watch.close") : t("plan.watch.cancel")}
        </button>
        {!disabled && (
          <button type="button" className="jr-button jr-primary" onClick={save}>
            {t("plan.watch.save")}
          </button>
        )}
      </footer>
    </dialog>
  );
}
