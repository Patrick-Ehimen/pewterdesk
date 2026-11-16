import { useRef, useState } from "react";

/** An on / off switch. */
export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`lab-switch-btn${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

/**
 * A number inside a sentence, underlined, typed in place ("Daily loss 3%").
 * `scale` turns what's kept into what's shown (100 for a share as %).
 */
export function InlineNum({
  value,
  onChange,
  label,
  suffix,
  scale = 1,
  min = 0,
  width = 3,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  suffix?: string;
  scale?: number;
  min?: number;
  width?: number;
}) {
  const shown = Number((value * scale).toFixed(4));
  const [text, setText] = useState(String(shown));
  const was = useRef(shown);
  if (was.current !== shown) {
    was.current = shown;
    if (Number(text) !== shown) setText(String(shown));
  }
  return (
    <span className="lab-inline">
      <input
        aria-label={label}
        inputMode="decimal"
        style={{ width: `${Math.max(width, text.length + 0.5)}ch` }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min) onChange(n / scale);
        }}
      />
      {suffix}
    </span>
  );
}

/** A time of day inside a sentence ("07:00"), typed in place. */
export function InlineTime({
  value,
  onChange,
  label,
  parse,
}: {
  value: string;
  onChange: (minutes: number) => void;
  label: string;
  parse: (text: string) => number | undefined;
}) {
  const [text, setText] = useState(value);
  const was = useRef(value);
  if (was.current !== value) {
    was.current = value;
    setText(value);
  }
  return (
    <span className="lab-inline">
      <input
        aria-label={label}
        style={{ width: "6.5ch" }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const m = parse(e.target.value);
          if (m !== undefined) onChange(m);
        }}
      />
    </span>
  );
}
