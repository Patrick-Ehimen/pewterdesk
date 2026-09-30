import type { Market, VenueId } from "@pewterdesk/core";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

/**
 * Fetches a market's logo as SVG markup, or resolves `undefined` when it has
 * none. The app supplies it (through a venue command); this package never
 * fetches anything itself.
 */
export type IconLoader = (market: string, venue: VenueId) => Promise<string | undefined>;

/**
 * A logo the app already has at hand (e.g. saved from an earlier session),
 * read synchronously so it shows on the first frame: SVG markup, `null` for
 * a market known to have none, or `undefined` to fetch it.
 */
export type IconPeek = (market: string, venue: VenueId) => string | null | undefined;

const LoaderContext = createContext<IconLoader | undefined>(undefined);
const PeekContext = createContext<IconPeek | undefined>(undefined);

/**
 * Logos already loaded, per loader and keyed `venue:id` (ids repeat across
 * venues), so remounted icons don't flash their letter.
 */
const loaded = new WeakMap<IconLoader, Map<string, string | null>>();

function cacheFor(load: IconLoader) {
  let cache = loaded.get(load);
  if (!cache) {
    cache = new Map();
    loaded.set(load, cache);
  }
  return cache;
}

/**
 * Lets every `TokenIcon` below fetch logos with `load`, looking in `peek`
 * first when given. Pass stable functions.
 */
export function TokenIconProvider({
  load,
  peek,
  children,
}: {
  load: IconLoader;
  peek?: IconPeek;
  children: ReactNode;
}) {
  return (
    <LoaderContext.Provider value={load}>
      <PeekContext.Provider value={peek}>{children}</PeekContext.Provider>
    </LoaderContext.Provider>
  );
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
  const peek = useContext(PeekContext);
  const id = market?.id;
  const venue = market?.venue;
  const key = id === undefined ? undefined : `${venue}:${id}`;
  const initial = (): IconState => {
    if (!load) return null;
    // No market yet (it's still loading too): shimmer until it arrives.
    if (key === undefined || id === undefined || venue === undefined) return "loading";
    const cache = cacheFor(load);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const saved = peek?.(id, venue);
    if (saved === undefined) return "loading";
    const url = saved === null ? null : svgUrl(saved);
    cache.set(key, url);
    return url;
  };
  const [src, setSrc] = useState<IconState>(initial);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `initial` reads only `load` and `key`
  useEffect(() => {
    const now = initial();
    setSrc(now);
    if (now !== "loading" || !load || id === undefined || venue === undefined || !key) return;
    const cache = cacheFor(load);
    let current = true;
    load(id, venue).then(
      (svg) => {
        const url = svg ? svgUrl(svg) : null;
        cache.set(key, url);
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
  }, [load, key]);

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
