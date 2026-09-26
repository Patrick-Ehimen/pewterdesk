// The loading screen: the depth-ladder mark with its bars breathing in turn,
// shown while the interface language loads and during a theme or language
// switch. Geometry matches
// assets/logo/pewterdesk-mark-*.svg; colors come from the brand tokens, so it
// follows the theme.

/** A language or theme switch keeps the splash up at least this long, so the change registers. */
export const SWITCH_SPLASH_MS = 1800;
/** Fade-out time. Keep in sync with `.splash[data-leaving]` in styles/app.css. */
export const SPLASH_FADE_MS = 350;
/** Fade-in time. Keep in sync with `.splash`'s splash-in animation. */
export const SPLASH_IN_MS = 200;

const BARS = [
  { x: 22, y: 7, width: 12 },
  { x: 14, y: 16, width: 28 },
  { x: 6, y: 25, width: 44, mid: true },
  { x: 14, y: 34, width: 28 },
  { x: 22, y: 43, width: 12 },
];

/** `leaving`: fading out over the app that has just mounted underneath. */
export function Splash({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      className="splash"
      data-leaving={leaving || undefined}
      role="status"
      aria-busy={!leaving}
      aria-hidden={leaving || undefined}
      aria-label="pewterdesk"
    >
      <svg className="splash-mark" viewBox="0 0 56 56" width="72" height="72" aria-hidden>
        {BARS.map((bar, i) => (
          <rect
            key={bar.y}
            className="splash-bar"
            data-mid={bar.mid || undefined}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={6}
            rx={3}
            style={{ animationDelay: `${i * 110}ms` }}
          />
        ))}
      </svg>
      <span className="splash-word" aria-hidden>
        <strong>pewter</strong>desk
      </span>
    </div>
  );
}
