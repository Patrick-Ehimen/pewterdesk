import { describe, expect, it } from "vitest";
import { MENU_PAGES } from "../src/lib/pages";
import {
  activePage,
  closed,
  initialTabs,
  MAX_TABS,
  opened,
  restoreTabs,
  selected,
  stepped,
  withPage,
} from "../src/lib/tabs";

describe("tabs", () => {
  it("each hold a page of their own", () => {
    let tabs = initialTabs();
    expect(activePage(tabs)).toBe("trade");
    // A second tab opens somewhere new, and is the one on screen.
    // A second tab opens on the next page in the menu not already open.
    tabs = opened(tabs);
    expect(tabs.tabs.map((t) => t.page)).toEqual(["trade", MENU_PAGES[1]]);
    expect(activePage(tabs)).toBe(MENU_PAGES[1]);
    // Changing the page changes this tab only.
    tabs = withPage(tabs, "portfolio");
    expect(tabs.tabs.map((t) => t.page)).toEqual(["trade", "portfolio"]);
    tabs = selected(tabs, 1);
    expect(activePage(tabs)).toBe("trade");
    expect(selected(tabs, 99)).toBe(tabs);
    expect(withPage(tabs, "trade")).toBe(tabs);
  });

  it("close to a neighbour, and never the last one", () => {
    let tabs = opened(initialTabs());
    expect(tabs.tabs).toHaveLength(2);
    // Closing the one on screen (the second) shows the first.
    tabs = closed(tabs, 2);
    expect(tabs.tabs.map((t) => t.id)).toEqual([1]);
    expect(tabs.active).toBe(1);
    expect(closed(tabs, 1)).toBe(tabs);
    // Closing the other leaves the one on screen there.
    tabs = closed(opened(tabs), 1);
    expect(tabs.tabs.map((t) => t.id)).toEqual([2]);
    expect(tabs.active).toBe(2);
  });

  it("stop at three, and step between them", () => {
    let tabs = initialTabs();
    for (let i = 0; i < 5; i++) tabs = opened(tabs);
    expect(MAX_TABS).toBe(3);
    expect(tabs.tabs).toHaveLength(3);
    // Each opened on a page of its own.
    expect(new Set(tabs.tabs.map((t) => t.page)).size).toBe(3);
    tabs = selected(tabs, 1);
    expect(stepped(tabs, 1).active).toBe(2);
    // Stepping wraps round, both ways.
    expect(stepped(tabs, -1).active).toBe(3);
    expect(stepped(selected(tabs, 3), 1).active).toBe(1);
  });

  it("come back as they were saved, as far as they read", () => {
    const tabs = restoreTabs({
      tabs: [
        { page: "trade" },
        { page: "nowhere" },
        { page: "charts" },
        { page: "maps" },
        { page: "news" },
      ],
      activeIndex: 1,
    });
    // What doesn't read is dropped, and no more than three come back.
    expect(tabs.tabs).toEqual([
      { id: 1, page: "trade" },
      { id: 3, page: "charts" },
      { id: 4, page: "maps" },
    ]);
    expect(activePage(tabs)).toBe("charts");
    // Nothing saved: one tab, on the page that was open before tabs existed.
    expect(restoreTabs(null, "maps")).toEqual(initialTabs("maps"));
  });
});
