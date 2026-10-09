import { formatNumber } from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";

/** An amount in USD, as the rules show them: "500.00". */
export const money = (v: number) => formatNumber(v, 2);

/** Minutes as "7h 56m", or "42m" under an hour. */
export const span = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

export type Tone = "ok" | "warn" | "over" | "info" | "brass" | "muted";

/** A small outlined label: "41.6% USED", "OK", "NEEDS A STOP". */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="rules-badge" data-tone={tone}>
      {children}
    </span>
  );
}

/** How much of something is used, with an optional tick (where a warning starts). */
export function Bar({
  label,
  share,
  tone = "ok",
  tick,
}: {
  label: string;
  /** 0 to 1; unset draws the empty track. */
  share?: number;
  tone?: Tone;
  tick?: number;
}) {
  const filled = Math.min(Math.max(share ?? 0, 0), 1);
  return (
    <div
      className="rules-bar"
      data-tone={tone}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(filled * 100)}
    >
      <span className="rules-bar-fill" style={{ width: `${filled * 100}%` }} />
      {tick !== undefined && <span className="rules-bar-tick" style={{ left: `${tick * 100}%` }} />}
    </div>
  );
}

/** The tone of a limit that's `share` used: fine, close, or reached. */
export const usedTone = (share: number): Tone =>
  share >= 1 ? "over" : share >= 0.8 ? "warn" : "ok";

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  /** After the number: "USD", "%", "×". */
  unit?: ReactNode;
  disabled?: boolean;
  /** Whole numbers only (a count). */
  whole?: boolean;
  /** Wider, for an amount of money. */
  wide?: boolean;
}

/** A number with its unit beside it. What's typed is kept until it reads as a number. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  disabled,
  whole,
  wide,
}: NumberFieldProps) {
  const [text, setText] = useState<string>();
  return (
    <span
      className="rules-field"
      data-disabled={disabled || undefined}
      data-wide={wide || undefined}
    >
      <input
        inputMode={whole ? "numeric" : "decimal"}
        aria-label={label}
        disabled={disabled}
        value={text ?? String(value)}
        onChange={(e) => {
          const next = e.target.value.replace(",", ".");
          if (!(whole ? /^\d*$/ : /^\d*\.?\d*$/).test(next)) return;
          setText(next);
          if (next !== "" && Number.isFinite(Number(next))) onChange(Number(next));
        }}
        onBlur={() => setText(undefined)}
      />
      {unit !== undefined && <span className="rules-unit">{unit}</span>}
    </span>
  );
}

/** A choice of a few, side by side. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="pd-segmented rules-seg"
      role="radiogroup"
      aria-label={label}
      data-disabled={disabled || undefined}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: compact segmented control, like the interval picker
        <button
          key={o.value}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={o.value === value}
          data-checked={o.value === value || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
