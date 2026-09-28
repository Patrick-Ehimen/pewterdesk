import type { Market } from "@pewterdesk/core";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

/**
 * Fetches a market's logo as SVG markup, or resolves `undefined` when it has
 * none. The app supplies it (through a venue command); this package never
 * fetches anything itself.
 */
export type IconLoader = (market: string) => Promise<string | undefined>;

const LoaderContext = createContext<IconLoader | undefined>(undefined);

/** Logos already loaded, per loader, so remounted icons don't flash their letter. */
const loaded = new WeakMap<IconLoader, Map<string, string | null>>();

function cacheFor(load: IconLoader) {
  let cache = loaded.get(load);
  if (!cache) {
    cache = new Map();
    loaded.set(load, cache);
  }
  return cache;
}

/** Lets every `TokenIcon` below fetch logos with `load`. Pass a stable function. */
export function TokenIconProvider({ load, children }: { load: IconLoader; children: ReactNode }) {
  return <LoaderContext.Provider value={load}>{children}</LoaderContext.Provider>;
}

/**
 * The venue's logo as a data URL. SVG shown through an `<img>` can't run
 * scripts or load anything else, which is why the markup never goes into
 * the page directly.
 */
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The badge letter: kPEPE (quoted per thousand) shows P, like its logo. */
const letterOf = (base: string) => base.replace(/^k(?=[A-Z])/, "").slice(0, 1);

/** A logo's data URL, `null` for none (show the letter), or still on its way. */
type IconState = string | null | "loading";

/**
 * A market's logo in a small circle: a shimmer while it loads, then the logo,
 * or the market's first letter when there's none (or it couldn't be fetched).
 * Decorative: the name always sits beside it.
 */
export function TokenIcon({
  market,
  size = 16,
  className,
}: {
  market?: Market;
  size?: number;
  className?: string;
}) {
  const load = useContext(LoaderContext);
  const id = market?.id;
  const initial = (): IconState => {
    if (!load) return null;
    // No market yet (it's still loading too): shimmer until it arrives.
    if (id === undefined) return "loading";
    const cached = cacheFor(load).get(id);
    return cached === undefined ? "loading" : cached;
  };
  const [src, setSrc] = useState<IconState>(initial);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `initial` reads only `load` and `id`
  useEffect(() => {
    const now = initial();
    setSrc(now);
    if (now !== "loading" || !load || id === undefined) return;
    const cache = cacheFor(load);
    let current = true;
    load(id).then(
      (svg) => {
        const url = svg ? svgUrl(svg) : null;
        cache.set(id, url);
        if (current) setSrc(url);
      },
      // Show the letter for now; a failed download isn't cached, so the
      // next mount tries again.
      () => {
        if (current) setSrc(null);
      },
    );
    return () => {
      current = false;
    };
  }, [load, id]);

  const loading = src === "loading";
  const classes = ["pd-token", className, loading && "pd-skel"].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      data-loading={loading || undefined}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden
    >
      {loading ? null : src ? (
        <img src={src} alt="" draggable={false} decoding="async" />
      ) : (
        letterOf(market?.base ?? "")
      )}
    </span>
  );
}
