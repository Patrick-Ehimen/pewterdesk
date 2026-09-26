import { type MessageKey, t } from "@pewterdesk/ui";

/** Every kind of panel the workspace can hold. A kind may appear more than once. */
export type PanelKind = "markets" | "orderBook" | "account" | "positions";

export interface PanelSpec {
  titleKey: MessageKey;
  /** Size when dropped from the palette, in grid units. */
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export const PANELS: Record<PanelKind, PanelSpec> = {
  markets: { titleKey: "panel.markets", w: 12, h: 12, minW: 6, minH: 5 },
  orderBook: { titleKey: "panel.orderBook", w: 5, h: 16, minW: 4, minH: 8 },
  account: { titleKey: "panel.account", w: 5, h: 10, minW: 4, minH: 6 },
  positions: { titleKey: "panel.positions", w: 16, h: 8, minW: 8, minH: 4 },
};

/** A panel's title in the interface language. */
export const panelTitle = (kind: PanelKind) => t(PANELS[kind].titleKey);

export const PANEL_KINDS = Object.keys(PANELS) as PanelKind[];

/** Panel ids are `<kind>:<suffix>`, so the kind survives a save and reload. */
export function panelKindOf(id: string): PanelKind | undefined {
  const kind = id.slice(0, id.indexOf(":"));
  return kind in PANELS ? (kind as PanelKind) : undefined;
}

export function newPanelId(kind: PanelKind): string {
  return `${kind}:${crypto.randomUUID().slice(0, 8)}`;
}
