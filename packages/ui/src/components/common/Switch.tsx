interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; usually the setting's visible title. */
  label: string;
  /** Can't be changed now (busy, or not available here). */
  disabled?: boolean;
}

/** An on/off toggle: a button with `role="switch"`, brass when on. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="pd-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="pd-switch-thumb" aria-hidden />
    </button>
  );
}
