import type { Theme } from "../../hooks/useAppearance";

/**
 * A miniature of a theme: its background, a panel with a line of text, the
 * brass accent and the two market colors. Setting data-theme on the swatch
 * scopes that theme's tokens to it, so every theme previews correctly
 * whichever one is active.
 */
export function ThemeSwatch({ theme }: { theme: Theme }) {
  return (
    <span className="theme-swatch" data-theme={theme} aria-hidden>
      <span className="theme-swatch-panel">
        <span className="theme-swatch-text" />
        <span className="theme-swatch-row">
          <span className="theme-swatch-brass" />
          <span className="theme-swatch-buy" />
          <span className="theme-swatch-sell" />
        </span>
      </span>
    </span>
  );
}
