// The pewterdesk logo, drawn from the brand tokens so it follows the theme
// (each theme sets its own text, pewter and accent colors), in place of the
// fixed light and dark image files. Its geometry is in `lib/logo.ts`.

import { LOGO_BARS, LOGO_DESK, LOGO_PEWTER } from "@pewterdesk/ui";

/**
 * The mark alone (the depth ladder), in the theme's colors, for use inside
 * another SVG: placed at `x`, `y` and `size` units square there.
 */
export function LogoMark({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
      {LOGO_BARS.map((bar) => (
        <rect
          key={bar.y}
          className={bar.mid ? "app-logo-accent" : "app-logo-pewter"}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={6}
          rx={3}
        />
      ))}
    </svg>
  );
}

/** The horizontal logo. `className` sizes it (set a height; the width follows). */
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg
      className={`app-logo-art ${className ?? ""}`}
      viewBox="0 0 227.28 56"
      role="img"
      aria-label="pewterdesk"
    >
      {LOGO_BARS.map((bar) => (
        <rect
          key={bar.y}
          className={bar.mid ? "app-logo-accent" : "app-logo-pewter"}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={6}
          rx={3}
        />
      ))}
      <path className="app-logo-text" d={LOGO_PEWTER} />
      <path className="app-logo-pewter" d={LOGO_DESK} />
    </svg>
  );
}
