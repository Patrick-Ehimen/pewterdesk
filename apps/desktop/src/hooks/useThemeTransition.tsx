import { useCallback, useEffect, useRef, useState } from "react";
import { SPLASH_FADE_MS, SPLASH_IN_MS, Splash, SWITCH_SPLASH_MS } from "../components/Splash";
import type { Theme } from "./useAppearance";

type Phase = "idle" | "covering" | "leaving";

/**
 * Switches theme behind the splash: it fades in over the app, the theme
 * changes once the screen is covered, and it fades out after the same
 * minimum as a language switch. No reload, so live feeds stay connected.
 * Render `overlay` last in the tree so it sits on top.
 */
export function useThemeTransition(setTheme: (theme: Theme) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const switchTheme = useCallback(
    (next: Theme) => {
      if (phase !== "idle") return;
      setPhase("covering");
      const at = (ms: number, run: () => void) => timers.current.push(setTimeout(run, ms));
      at(SPLASH_IN_MS, () => setTheme(next));
      at(SWITCH_SPLASH_MS, () => setPhase("leaving"));
      at(SWITCH_SPLASH_MS + SPLASH_FADE_MS, () => {
        timers.current = [];
        setPhase("idle");
      });
    },
    [phase, setTheme],
  );

  const overlay = phase === "idle" ? null : <Splash leaving={phase === "leaving"} />;
  return { switchTheme, overlay };
}
