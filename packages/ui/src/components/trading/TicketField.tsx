import type { ReactNode } from "react";

/** Digits and one decimal point only; a comma counts as the point. */
const numeric = (value: string) => {
  const next = value.replace(",", ".");
  return /^\d*\.?\d*$/.test(next) ? next : undefined;
};

/** A labelled number input in the order ticket, with an optional unit or switch after it. */
export function NumberField({
  label,
  value,
  onChange,
  suffix,
  placeholder,
  state,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: ReactNode;
  placeholder?: string;
  /** Outlines the field where a check found something. */
  state?: "error" | "warn";
}) {
  return (
    <label className="pd-ticket-field" data-state={state}>
      <span className="pd-ticket-field-label">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const next = numeric(e.target.value);
          if (next !== undefined) onChange(next);
        }}
      />
      {suffix}
    </label>
  );
}
