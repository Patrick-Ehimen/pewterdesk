import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useRef, useState, type WheelEvent } from "react";
import type { IconType } from "react-icons";
import { LuBookOpen, LuLifeBuoy, LuScale } from "react-icons/lu";
import { type AboutLink, appClient } from "../api/appClient";
import { ConnectionPanel } from "./ConnectionPanel";

export type Connection = "online" | "connecting" | "offline";

const LABEL = {
  online: "status.online",
  connecting: "status.connecting",
  offline: "status.offline",
} as const;

const LINKS: {
  link: AboutLink;
  label: "footer.docs" | "footer.support" | "footer.license";
  Icon: IconType;
}[] = [
  { link: "repository", label: "footer.docs", Icon: LuBookOpen },
  { link: "issues", label: "footer.support", Icon: LuLifeBuoy },
  { link: "license", label: "footer.license", Icon: LuScale },
];

/**
 * A row that scrolls sideways: the wheel's up and down move it too, and
 * `start`/`end` say whether there's more to see that way (for edge fades).
 */
function useSideScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setEdges({
        start: el.scrollLeft > 1,
        end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
  };
  return { ref, ...edges, onWheel };
}

/** At most one heartbeat per this long, however fast the feed pushes. */
export const BEAT_MS = 2000;

/**
 * The app's bottom bar: the venue on screen, which is also the connection
 * status, and links to the project. Online, the venue's logo sits in a
 * green ring that pings with each fresh update (`beat`); connecting, it's
 * grey in a slowly turning dashed ring; offline, grey in an orange one.
 * Clicking it opens the connection panel. Links open in the system browser
 * through the About box's fixed-link opener, so the page can't open
 * anything else.
 */
export function StatusBar({
  connection,
  venue,
  venueId,
  market,
  venueLogo,
  beat,
  children,
  right,
}: {
  connection: Connection;
  venue: string;
  venueId: VenueId;
  /** The market on screen, which the panel times its REST round trip with. */
  market?: string;
  venueLogo?: string;
  /** Changes when fresh data arrives (at most every `BEAT_MS`); each change pings. */
  beat?: number;
  /** More of the bar after the badge: PnL, market movement, tickers. */
  children?: ReactNode;
  /** The bar's right end, before the links: funding, latency, the clock. */
  right?: ReactNode;
}) {
  const online = connection === "online";
  const scroller = useSideScroll();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <footer className="app-status">
      <div ref={wrapRef} className="app-status-conn">
        <button
          type="button"
          className="app-status-venue"
          data-state={connection}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={`${t("status.hint", { venue })} · ${t(LABEL[connection])}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="app-venue-badge" aria-hidden>
            {venueLogo ? (
              <img src={venueLogo} alt="" width={14} height={14} />
            ) : (
              <span className="pd-live-dot" />
            )}
            <span className="app-venue-ring" />
            {/* Re-keyed per beat, so the ping replays. */}
            {online && beat !== undefined && <span key={beat} className="app-venue-ping" />}
          </span>
          <span className="app-venue-name">{venue}</span>
          {/* Online is the quiet default: only the other states say so. */}
          <span className={online ? "pd-visually-hidden" : "app-venue-state"} role="status">
            {t(LABEL[connection])}
          </span>
        </button>
        {open && <ConnectionPanel venue={venue} venueId={venueId} market={market} />}
      </div>
      {/* The middle slides sideways when it doesn't fit; the badge and the links stay put. */}
      <div
        ref={scroller.ref}
        className="app-status-scroll"
        data-more-start={scroller.start || undefined}
        data-more-end={scroller.end || undefined}
        onWheel={scroller.onWheel}
      >
        {children}
        <span className="app-spacer" />
        {right}
      </div>
      <nav className="app-status-links" aria-label={t("status.links")}>
        {LINKS.map(({ link, label, Icon }) => (
          <button
            key={link}
            type="button"
            title={t(label)}
            onClick={() => appClient.openLink(link).catch(() => {})}
          >
            <Icon size={13} aria-hidden />
            <span className="app-status-link-text">{t(label)}</span>
          </button>
        ))}
      </nav>
    </footer>
  );
}
