import type { MarginMode } from "@pewterdesk/core";
import { useState } from "react";
import { t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { Shell, Stepper } from "./ProtectionEditor";

/** Where the leverage slider puts its marks, as fractions of the maximum. */
const MARKS = [0, 0.25, 0.5, 0.75, 1];
/** Above this, the dialog warns how close liquidation gets. */
const HIGH_LEVERAGE = 20;

/** Saves, then closes; a refusal stays on screen with the venue's reason. */
function useSave<T>(onSave: (value: T) => Promise<void>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (value: T) => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return { busy, error, setError, save };
}

/** Cross or isolated margin, each with what it means. */
export function MarginModeDialog({
  current,
  accountWide,
  onSave,
  onClose,
}: {
  current: MarginMode;
  /** The venue sets it for the whole account, which the dialog says. */
  accountWide: boolean;
  onSave: (mode: MarginMode) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(current);
  const { busy, error, save } = useSave(onSave, onClose);
  return (
    <Shell
      title={t("ticket.marginTitle")}
      stats={[]}
      busy={busy}
      error={error}
      onSubmit={() => (mode === current ? onClose() : void save(mode))}
      onClose={onClose}
    >
      <div className="pd-margin-modes" role="radiogroup" aria-label={t("ticket.marginTitle")}>
        {(["cross", "isolated"] as const).map((m) => (
          // biome-ignore lint/a11y/useSemanticElements: a choice of two cards, each with its own text
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="pd-margin-mode"
            onClick={() => setMode(m)}
          >
            <span className="pd-margin-mode-name">
              {t(m === "cross" ? "ticket.cross" : "ticket.isolated")}
            </span>
            <span className="pd-margin-mode-hint">
              {t(m === "cross" ? "ticket.crossHint" : "ticket.isolatedHint")}
            </span>
          </button>
        ))}
      </div>
      {accountWide && <p className="pd-protect-est">{t("ticket.accountWide")}</p>}
    </Shell>
  );
}

/** The leverage for one market: a box with steppers, and a slider up to the market's maximum. */
export function LeverageDialog({
  symbol,
  current,
  max,
  onSave,
  onClose,
}: {
  symbol: string;
  current: number;
  max: number;
  onSave: (leverage: number) => Promise<void>;
  onClose: () => void;
}) {
  const top = Math.max(1, Math.floor(max));
  const [text, setText] = useState(String(current));
  const { busy, error, setError, save } = useSave(onSave, onClose);
  const value = Number(text);
  const valid = Number.isInteger(value) && value >= 1 && value <= top;
  const shown = valid ? value : Math.min(top, Math.max(1, Math.round(value) || 1));
  const marks = [...new Set(MARKS.map((f) => Math.max(1, Math.round(f * top))))];
  return (
    <Shell
      title={t("ticket.leverageTitle", { symbol })}
      stats={[]}
      busy={busy}
      error={error}
      onSubmit={() => {
        if (!valid) return setError(t("ticket.leverageRange", { max: top }));
        if (value === current) return onClose();
        void save(value);
      }}
      onClose={onClose}
    >
      <span className="pd-protect-label">{t("ticket.leverage")}</span>
      <Stepper
        value={text}
        onChange={(v) => setText(v.replace(/[^0-9]/g, ""))}
        step="1"
        from={current}
        placeholder=""
        label={t("ticket.leverage")}
        suffix="x"
      />
      <div className="pd-leverage-slider">
        <input
          type="range"
          min={1}
          max={top}
          step={1}
          value={shown}
          aria-label={t("ticket.leverage")}
          style={{ ["--pd-fill" as string]: `${top > 1 ? ((shown - 1) / (top - 1)) * 100 : 100}%` }}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="pd-leverage-marks">
          {marks.map((m) => (
            <button key={m} type="button" onClick={() => setText(String(m))}>
              {formatNumber(m, 0)}x
            </button>
          ))}
        </div>
      </div>
      {shown > HIGH_LEVERAGE && <p className="pd-protect-est">{t("ticket.leverageRisk")}</p>}
    </Shell>
  );
}
