interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; usually the setting's visible title. */
  label: string;
}

/** An on/off toggle: a button with `role="switch"`, brass when on. */
export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="pd-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="pd-switch-thumb" aria-hidden />
    </button>
  );
}
