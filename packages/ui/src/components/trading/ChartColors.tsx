import { type DrawingText, drawingSettingsSchema } from "openalgo-charts/draw";
import { type Widget, widgetDialog } from "openalgo-charts/widget";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LuAlignCenter,
  LuAlignLeft,
  LuAlignRight,
  LuAlignVerticalJustifyCenter,
  LuAlignVerticalJustifyEnd,
  LuAlignVerticalJustifyStart,
  LuBellPlus,
  LuBold,
  LuEye,
  LuItalic,
  LuPaintBucket,
  LuPlus,
  LuSettings,
  LuType,
} from "react-icons/lu";
import { t } from "../../i18n";
import {
  COLOR_BASE,
  COLOR_RAMPS,
  drawingPrice,
  type PickedColor,
  readColor,
  writeColor,
} from "../../lib/chartColors";
import {
  canToggle,
  FRAME_GROUPS,
  type FrameGroup,
  framesOf,
  shownGroups,
} from "../../lib/drawingFrames";
import { clearPatch, revertPatch } from "../../lib/drawingRevert";
import { isLineTool } from "./lineText";
import { isRangeProfile } from "./rangeProfile";

// The chart's colour picker, in place of the library's everywhere one opens:
// a full grid, a custom colour and opacity, and no list of recent colours. On
// a selected drawing's toolbar it adds fill and text beside the line colour.

const PICKER_WIDTH = 268;
const PICKER_HEIGHT = 330;
const EDGE = 8;

/** The grid, a custom colour and, where it applies, opacity. */
export function ColorPicker({
  value,
  opacity = true,
  onChange,
}: {
  value: PickedColor;
  /** Whether this colour can take one. */
  opacity?: boolean;
  onChange: (next: PickedColor) => void;
}) {
  const custom = useRef<HTMLInputElement>(null);
  const row = (colors: readonly string[]) => (
    <div key={colors.join()} className="pd-color-row">
      {colors.map((hex) => (
        <button
          key={hex}
          type="button"
          className="pd-color-swatch"
          aria-label={hex}
          aria-pressed={hex === value.hex}
          style={{ backgroundColor: hex }}
          onClick={() => onChange({ ...value, hex })}
        />
      ))}
    </div>
  );
  const percent = Math.round(value.alpha * 100);
  return (
    <>
      <div className="pd-color-block">{COLOR_BASE.map(row)}</div>
      <div className="pd-color-block">{COLOR_RAMPS.map(row)}</div>
      <hr className="pd-color-rule" />
      <button
        type="button"
        className="pd-color-add"
        aria-label={t("chart.colorCustom")}
        title={t("chart.colorCustom")}
        onClick={() => custom.current?.click()}
      >
        <LuPlus size={18} aria-hidden />
      </button>
      <input
        ref={custom}
        className="pd-visually-hidden"
        type="color"
        tabIndex={-1}
        aria-hidden
        value={value.hex}
        onChange={(e) => onChange({ ...value, hex: e.target.value })}
      />
      {opacity && (
        <label className="pd-color-opacity">
          <span>{t("chart.colorOpacity")}</span>
          <span className="pd-color-opacity-row">
            <span
              className="pd-color-track"
              style={{ "--color": value.hex } as React.CSSProperties}
            >
              <input
                type="range"
                min={0}
                max={100}
                value={percent}
                aria-label={t("chart.colorOpacity")}
                onChange={(e) => onChange({ ...value, alpha: Number(e.target.value) / 100 })}
              />
            </span>
            <output className="pd-color-percent pd-num">{percent}%</output>
          </span>
        </label>
      )}
    </>
  );
}

const ALIGNS = [
  { align: "left", label: "chart.textLeft", icon: <LuAlignLeft size={16} aria-hidden /> },
  { align: "center", label: "chart.textCenter", icon: <LuAlignCenter size={16} aria-hidden /> },
  { align: "right", label: "chart.textRight", icon: <LuAlignRight size={16} aria-hidden /> },
] as const;

const VALIGNS = [
  {
    valign: "top",
    label: "chart.textTop",
    icon: <LuAlignVerticalJustifyStart size={16} aria-hidden />,
  },
  {
    valign: "middle",
    label: "chart.textMiddle",
    icon: <LuAlignVerticalJustifyCenter size={16} aria-hidden />,
  },
  {
    valign: "bottom",
    label: "chart.textBottom",
    icon: <LuAlignVerticalJustifyEnd size={16} aria-hidden />,
  },
] as const;

type Kind = "line" | "fill" | "text";

interface Open {
  /** What it's changing: a part of the selected drawings, or one of the library's fields. */
  kind?: Kind;
  input?: HTMLInputElement;
  value: PickedColor;
  left: number;
  top: number;
}

/** A selected drawing's fill colour, as the bar shows and the picker edits it. */
const fillOf = (style: { fillColor?: string; color?: string; fillOpacity?: number }) => ({
  hex: readColor(style.fillColor ?? style.color).hex,
  alpha: style.fillOpacity ?? 0.12,
});

/**
 * Takes every colour control in this chart over with `ColorPicker`, and adds
 * fill and text to the selected drawing's toolbar. It only changes drawings
 * and chart settings; it never reaches an order.
 */
export function ChartColors({
  widget,
  intervals,
  onAlert,
}: {
  widget: Widget;
  /** The chart's interval codes, shortest first, for showing a drawing on only some. */
  intervals: readonly string[];
  /** Sets a price alert at a drawing; no button without it. */
  onAlert?: (price: number, last: number, title: string) => void;
}) {
  const [open, setOpen] = useState<Open>();
  const [showing, setShowing] = useState<{ left: number; top: number }>();
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement>();
  const [endSlot, setEndSlot] = useState<HTMLElement>();
  const [, redraw] = useState(0);

  const place = useCallback((target: Element) => {
    const stage = anchor.current?.parentElement?.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    if (!stage) return { left: 0, top: 0 };
    return {
      left: Math.max(EDGE, Math.min(at.left - stage.left, stage.width - PICKER_WIDTH - EDGE)),
      top: Math.max(EDGE, Math.min(at.bottom - stage.top + 6, stage.height - PICKER_HEIGHT - EDGE)),
    };
  }, []);

  const selected = () => widget.draw.selection().flatMap((id) => widget.draw.get(id) ?? []);

  const openFor = useCallback(
    (kind: Kind, target: Element) => {
      const first = widget.draw.selection().flatMap((id) => widget.draw.get(id) ?? [])[0];
      if (!first) return;
      const value =
        kind === "fill"
          ? fillOf(first.style)
          : readColor(
              kind === "text" ? (first.text?.color ?? first.style.color) : first.style.color,
            );
      setOpen((was) => (was?.kind === kind ? undefined : { kind, value, ...place(target) }));
    },
    [widget, place],
  );

  // The library's colour buttons, wherever they are, open this instead.
  useEffect(() => {
    const root = widget.root;
    const onClick = (e: MouseEvent) => {
      const trigger = (e.target as Element).closest?.(".oac-color__trigger");
      if (!trigger) return;
      e.preventDefault();
      e.stopPropagation();
      if (trigger.closest(".oac-drawbar")) return openFor("line", trigger);
      const input = trigger.parentElement?.querySelector<HTMLInputElement>(".oac-swatch-input");
      if (!input) return;
      const value = readColor(input.value);
      setOpen((was) => (was?.input === input ? undefined : { input, value, ...place(trigger) }));
    };
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [widget, openFor, place]);

  // A place on the drawing's toolbar for fill and text, after the line colour.
  useEffect(() => {
    const bar = widget.root.querySelector(".oac-drawbar");
    const color = bar?.querySelector(".oac-drawbar__color");
    if (!bar || !color) return;
    const extra = document.createElement("span");
    extra.className = "pd-drawbar-extra";
    color.after(extra);
    setSlot(extra);
    const end = document.createElement("span");
    end.className = "pd-drawbar-extra";
    // The separator before the lock: its own label comes only with a selection.
    bar.querySelector(".oac-sep")?.before(end);
    setEndSlot(end);
    return () => {
      extra.remove();
      end.remove();
    };
  }, [widget]);

  // What's selected decides which of them show, and a new selection closes the picker.
  useEffect(() => {
    if (widget.isDestroyed) return;
    const { chart } = widget;
    const update = () => redraw((n) => n + 1);
    const moved = () => {
      setOpen((was) => (was?.kind ? undefined : was));
      setShowing(undefined);
      update();
    };
    const off = [
      chart.on("draw:select", moved),
      chart.on("drawing:change", update),
      chart.on("draw:update", update),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, [widget]);

  // A drawing's dialog changes it as you go and has only Done, so it gets a
  // Cancel that puts back what it held on opening. Restore defaults knows
  // only the library's own settings, so a profile's are cleared beside it.
  useEffect(() => {
    const root = widget.root;
    let dialog: Element | null = null;
    const watch = new MutationObserver(() => {
      const found = root.querySelector(".oac-props");
      if (found === dialog) return;
      dialog = found;
      const actions = found?.querySelector(".oac-dialog__actions");
      const done = actions?.querySelector<HTMLElement>(".oac-btn");
      if (!actions || !done) return;
      const before = structuredClone(
        widget.draw.selection().flatMap((id) => widget.draw.get(id) ?? []),
      );
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "oac-btn";
      cancel.textContent = t("chart.dialogCancel");
      cancel.addEventListener("click", () => {
        widget.draw.updateMany(
          before.flatMap((was) => {
            const now = widget.draw.get(was.id);
            if (!now) return [];
            const patch = {
              points: was.points,
              style: revertPatch(was.style, now.style),
              props: revertPatch(was.props, now.props),
              text: revertPatch(was.text ?? { value: "" }, now.text),
            };
            return [{ id: was.id, patch }];
          }),
        );
        done.click();
      });
      actions.prepend(cancel);
    });
    watch.observe(root, { childList: true, subtree: true });
    const onClick = (e: MouseEvent) => {
      const restore = (e.target as Element).closest?.(
        ".oac-props .oac-dialog__lead .oac-btn:first-child",
      );
      if (!restore) return;
      widget.draw.updateMany(
        widget.draw
          .selection()
          .flatMap((id) => widget.draw.get(id) ?? [])
          .filter((d) => isRangeProfile(d.tool))
          .map((d) => ({ id: d.id, patch: { props: clearPatch(d.props) } })),
      );
    };
    root.addEventListener("click", onClick, true);
    return () => {
      watch.disconnect();
      root.removeEventListener("click", onClick, true);
    };
  }, [widget]);

  useEffect(() => {
    if (!open && !showing) return;
    const onDown = (e: PointerEvent) => {
      const on = e.target as Element;
      // The picker sits outside the dialog it opened from, and a drawing's
      // dialog closes on a press outside it, taking the field being set along.
      if (box.current?.contains(on)) {
        e.stopPropagation();
        return;
      }
      if (on.closest?.(".pd-drawbar-color, .oac-color__trigger")) return;
      setOpen(undefined);
      setShowing(undefined);
    };
    // First in line, so Escape closes this and not the dialog it opened from.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(undefined);
      setShowing(undefined);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, showing]);

  const openSettings = () => {
    // It opens on what's selected.
    widgetDialog("drawingProperties")?.(widget.context);
  };
  const setAlert = () => {
    const drawing = selected()[0];
    const last = widget.series.getData().at(-1)?.close;
    if (!drawing || last === undefined || !onAlert) return;
    const price = drawingPrice(drawing.tool, drawing.points, Math.floor(Date.now() / 1000));
    if (price !== undefined) onAlert(price, last, t("chart.drawingAlertNote"));
  };
  const setText = (change: Partial<DrawingText>) => {
    widget.draw.updateMany(
      selected().map((d) => ({ id: d.id, patch: { text: { value: "", ...d.text, ...change } } })),
    );
    redraw((n) => n + 1);
  };
  const setFrames = (ticked: readonly FrameGroup[]) => {
    const { range, hidden } = framesOf(ticked, intervals);
    widget.draw.updateMany(
      selected().map((d) => ({
        id: d.id,
        patch: { intervals: range, props: { hiddenFrames: hidden } },
      })),
    );
    redraw((n) => n + 1);
  };

  const apply = (next: PickedColor) => {
    if (!open) return;
    setOpen({ ...open, value: next });
    if (open.input) {
      open.input.value = next.hex;
      for (const type of ["input", "change"]) {
        open.input.dispatchEvent(new Event(type, { bubbles: true }));
      }
      return;
    }
    const { kind } = open;
    widget.draw.updateMany(
      selected().map((d) => ({
        id: d.id,
        patch:
          kind === "fill"
            ? { style: { fill: true, fillColor: next.hex, fillOpacity: next.alpha } }
            : kind === "text"
              ? { text: { ...(d.text ?? { value: "" }), color: writeColor(next) } }
              : { style: { color: writeColor(next) } },
      })),
    );
  };

  const first = selected()[0];
  const schema = first ? JSON.stringify(drawingSettingsSchema(first.tool)) : "";
  const hasFill = schema.includes("style.fillColor");
  const hasText = schema.includes("text.color");
  const button = (kind: "fill" | "text", label: string, color: string | undefined) => (
    <button
      type="button"
      className="oac-btn pd-drawbar-color"
      aria-label={label}
      title={label}
      aria-expanded={open?.kind === kind}
      onClick={(e) => openFor(kind, e.currentTarget)}
    >
      {kind === "fill" ? <LuPaintBucket size={19} aria-hidden /> : <LuType size={19} aria-hidden />}
      <span
        className="pd-drawbar-stripe"
        data-none={color === undefined || undefined}
        style={{ backgroundColor: color }}
      />
    </button>
  );

  return (
    <div ref={anchor}>
      {slot &&
        first &&
        createPortal(
          <>
            {hasFill &&
              button(
                "fill",
                t("chart.colorFill"),
                first.style.fill ? writeColor(fillOf(first.style)) : undefined,
              )}
            {hasText &&
              button("text", t("chart.colorText"), first.text?.color ?? first.style.color)}
          </>,
          slot,
        )}
      {endSlot &&
        first &&
        createPortal(
          <>
            <button
              type="button"
              className="oac-btn pd-drawbar-action"
              aria-label={t("chart.drawingSettings")}
              title={t("chart.drawingSettings")}
              onClick={openSettings}
            >
              <LuSettings size={20} aria-hidden />
            </button>
            {onAlert && (
              <button
                type="button"
                className="oac-btn pd-drawbar-action"
                aria-label={t("chart.drawingAlert")}
                title={t("chart.drawingAlert")}
                onClick={setAlert}
              >
                <LuBellPlus size={20} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="oac-btn pd-drawbar-action pd-drawbar-color"
              aria-label={t("chart.drawingVisibility")}
              title={t("chart.drawingVisibility")}
              aria-expanded={showing !== undefined}
              data-limited={first.intervals ? true : undefined}
              onClick={(e) => {
                const at = place(e.currentTarget);
                setOpen(undefined);
                setShowing((was) => (was ? undefined : at));
              }}
            >
              <LuEye size={20} aria-hidden />
            </button>
          </>,
          endSlot,
        )}
      {showing && first && (
        <div
          ref={box}
          className="pd-color-picker pd-draw-visibility"
          role="dialog"
          aria-label={t("chart.drawingVisibility")}
          style={{ left: showing.left, top: showing.top }}
        >
          <p className="pd-draw-label">{t("chart.drawingVisibility")}</p>
          {FRAME_GROUPS.map((group) => {
            const ticked = shownGroups(
              first.intervals,
              first.props?.hiddenFrames as string[] | undefined,
              intervals,
            );
            const on = ticked.includes(group);
            const can = canToggle(group, ticked);
            return (
              <label key={group} className="pd-draw-tick" data-locked={can ? undefined : true}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!can}
                  onChange={() =>
                    setFrames(on ? ticked.filter((g) => g !== group) : [...ticked, group])
                  }
                />
                {t(`chart.${group}`)}
              </label>
            );
          })}
        </div>
      )}
      {open && (
        <div
          ref={box}
          className="pd-color-picker"
          role="dialog"
          aria-label={t("chart.colorPicker")}
          style={{ left: open.left, top: open.top }}
        >
          {open.kind === "text" && first && (
            <textarea
              // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
              autoFocus
              className="pd-color-text"
              rows={2}
              maxLength={200}
              placeholder={t("chart.drawingText")}
              aria-label={t("chart.drawingText")}
              value={first.text?.value ?? ""}
              onChange={(e) => setText({ value: e.target.value })}
            />
          )}
          {open.kind === "text" && first && (
            <div className="pd-color-format">
              {schema.includes("text.bold") && (
                <div className="pd-color-aligns">
                  <button
                    type="button"
                    aria-pressed={first.text?.bold === true}
                    aria-label={t("chart.textBold")}
                    title={t("chart.textBold")}
                    onClick={() => setText({ bold: !first.text?.bold })}
                  >
                    <LuBold size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-pressed={first.text?.italic === true}
                    aria-label={t("chart.textItalic")}
                    title={t("chart.textItalic")}
                    onClick={() => setText({ italic: !first.text?.italic })}
                  >
                    <LuItalic size={16} aria-hidden />
                  </button>
                </div>
              )}
              {schema.includes("text.fontSize") && (
                <input
                  className="pd-color-size"
                  type="number"
                  min={6}
                  max={96}
                  aria-label={t("chart.textSize")}
                  title={t("chart.textSize")}
                  value={first.text?.fontSize ?? 14}
                  onChange={(e) => {
                    const size = e.target.valueAsNumber;
                    if (size >= 6 && size <= 96) setText({ fontSize: size });
                  }}
                />
              )}
              {schema.includes("text.align") && (
                <div
                  className="pd-color-aligns"
                  role="radiogroup"
                  aria-label={t("chart.textAlign")}
                >
                  {ALIGNS.map(({ align, label, icon }) => (
                    // biome-ignore lint/a11y/useSemanticElements: toolbar-style radio, like the chart's intervals
                    <button
                      key={align}
                      type="button"
                      role="radio"
                      aria-checked={
                        (first.text?.align ?? (isLineTool(first.tool) ? "center" : "left")) ===
                        align
                      }
                      aria-label={t(label)}
                      title={t(label)}
                      onClick={() => setText({ align })}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              )}
              {schema.includes("text.valign") && (
                <div
                  className="pd-color-aligns"
                  role="radiogroup"
                  aria-label={t("chart.textVertical")}
                >
                  {VALIGNS.map(({ valign, label, icon }) => (
                    // biome-ignore lint/a11y/useSemanticElements: toolbar-style radio, like the chart's intervals
                    <button
                      key={valign}
                      type="button"
                      role="radio"
                      aria-checked={(first.text?.valign ?? "top") === valign}
                      aria-label={t(label)}
                      title={t(label)}
                      onClick={() => setText({ valign })}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <ColorPicker value={open.value} opacity={open.input === undefined} onChange={apply} />
        </div>
      )}
    </div>
  );
}
