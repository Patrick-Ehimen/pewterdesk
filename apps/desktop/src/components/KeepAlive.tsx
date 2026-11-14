import { type ReactNode, type UIEvent, useLayoutEffect, useRef } from "react";

/**
 * Keeps a page mounted while another is on screen, so coming back finds it
 * as it was left: its charts, filters, selection and scroll. Hidden, it
 * takes no room (`display: none`); shown, it lays out as if it weren't
 * wrapped (`display: contents`). A box that's hidden forgets where it was
 * scrolled, so each scroll is noted as it happens and put back on return.
 */
export function KeepAlive({ shown, children }: { shown: boolean; children: ReactNode }) {
  const scrolled = useRef(new Map<Element, { top: number; left: number }>());
  useLayoutEffect(() => {
    if (!shown) return;
    for (const [box, at] of scrolled.current) {
      if (!box.isConnected) {
        scrolled.current.delete(box);
        continue;
      }
      box.scrollTop = at.top;
      box.scrollLeft = at.left;
    }
  }, [shown]);
  const note = (e: UIEvent) => {
    const box = e.target;
    if (shown && box instanceof Element) {
      scrolled.current.set(box, { top: box.scrollTop, left: box.scrollLeft });
    }
  };
  return (
    <div
      style={{ display: shown ? "contents" : "none" }}
      aria-hidden={shown ? undefined : true}
      onScrollCapture={note}
    >
      {children}
    </div>
  );
}
