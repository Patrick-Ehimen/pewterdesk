import { venueLogos } from "@pewterdesk/assets";
import type { Market, VenueId } from "@pewterdesk/core";
import { MarketMovement, t } from "@pewterdesk/ui";
import { LuActivity } from "react-icons/lu";
import { useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import { VENUES } from "../../lib/venues";
import { BarPopover } from "./BarPopover";

/** Both venues' summaries and names, loaded only while the panel is open. */
function MovementPanel({
  venue,
  markets,
  onOpenMarket,
}: {
  venue: VenueId;
  markets: readonly Market[];
  onOpenMarket: (venue: VenueId, market: string) => void;
}) {
  // One hook per venue, in a fixed order.
  const hl = useMarketSummaries("hyperliquid", true);
  const aster = useMarketSummaries("aster", true);
  const hlMarkets = useMarkets(venue === "hyperliquid" ? undefined : "hyperliquid");
  const asterMarkets = useMarkets(venue === "aster" ? undefined : "aster");
  const data = (f: typeof hl) =>
    f.status === "live" || f.status === "closed" ? f.data : undefined;
  const list = (id: VenueId, f: typeof hlMarkets) =>
    id === venue ? markets : f.status === "live" ? f.data : [];
  return (
    <MarketMovement
      venues={[
        {
          id: "hyperliquid",
          label: VENUES.hyperliquid.label,
          logo: venueLogos.hyperliquid,
          summaries: data(hl),
          markets: list("hyperliquid", hlMarkets),
        },
        {
          id: "aster",
          label: VENUES.aster.label,
          logo: venueLogos.aster,
          summaries: data(aster),
          markets: list("aster", asterMarkets),
        },
      ]}
      onOpenMarket={onOpenMarket}
    />
  );
}

/** The bottom bar's Market movement button and panel. */
export function Movement(props: {
  venue: VenueId;
  markets: readonly Market[];
  onOpenMarket: (venue: VenueId, market: string) => void;
}) {
  return (
    <BarPopover
      button={
        <>
          <LuActivity size={13} aria-hidden />
          {t("movement.title")}
        </>
      }
    >
      {() => <MovementPanel {...props} />}
    </BarPopover>
  );
}
