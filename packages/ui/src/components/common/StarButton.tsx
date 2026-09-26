import { LuStar } from "react-icons/lu";
import { t } from "../../i18n";
import { IconButton } from "./IconButton";

interface StarButtonProps {
  starred: boolean;
  /** What's being starred, for the label, e.g. "HYPE-USD". */
  name: string;
  onToggle: () => void;
  size?: number;
  className?: string;
}

/** Watchlist toggle: an outline star that fills in brass when on. */
export function StarButton({ starred, name, onToggle, size = 17, className }: StarButtonProps) {
  return (
    <IconButton
      label={t(starred ? "star.remove" : "star.add", { name })}
      pressed={starred}
      className={`pd-star ${className ?? ""}`}
      onClick={onToggle}
    >
      <LuStar size={size} fill={starred ? "currentColor" : "none"} aria-hidden />
    </IconButton>
  );
}
