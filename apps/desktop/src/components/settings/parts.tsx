import { type MenuOption, t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/** A section's heading and one-line intro. */
export function SectionHead({ title, description }: { title: string; description: string }) {
  return (
    <header className="settings-head">
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

/** A small uppercase group label, as in the design ("API WALLETS"). */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="settings-group">{children}</h3>;
}

/** One setting: title and help on the left, its control on the right. */
export function SettingRow({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <strong>{title}</strong>
        {help && <span>{help}</span>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** A single-choice group drawn as cards; native radios underneath for keyboard and screen readers. */
export function ChoiceCards<V extends string>({
  legend,
  options,
  value,
  onChange,
  columns,
}: {
  legend: string;
  options: readonly MenuOption<V>[];
  value: V;
  onChange: (value: V) => void;
  columns: number;
}) {
  const name = useId();
  return (
    <fieldset className="settings-cards" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      <legend className="pd-visually-hidden">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="settings-card"
          data-checked={option.value === value || undefined}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon}
          <span className="settings-card-text">
            <strong>{option.label}</strong>
            {option.description && <span>{option.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const CONFIRM_WINDOW_MS = 4000;

/**
 * A destructive action that takes two clicks: the first arms it (and says
 * so), the second within a few seconds runs it. Avoids window.confirm, which
 * the desktop webview doesn't show.
 */
export function ConfirmButton({
  children,
  onConfirm,
}: {
  children: ReactNode;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="settings-button"
      data-danger
      data-armed={armed || undefined}
      onClick={() => {
        if (armed) {
          clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
      }}
    >
      {armed ? t("settings.confirm") : children}
    </button>
  );
}

/** A button that briefly says "Done" after it runs, for actions with no other visible result. */
export function DoneButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="settings-button"
      onClick={() => {
        onClick();
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? t("settings.doneFeedback") : children}
    </button>
  );
}
