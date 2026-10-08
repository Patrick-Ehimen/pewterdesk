import type { IconLoader } from "@pewterdesk/ui";
import { coinClient, venueClient } from "../api/venueClient";
import { bundledLogo } from "./bundledLogos";
import { cachedPrice } from "./cachedPrices";
import { withIconCache } from "./iconCache";
import { marketLogo } from "./marketIcons";

/**
 * Market logos for every window (the main one, the tray panel, the floating
 * window): from the venues, then the logos that ship with the app, then
 * CoinGecko for a crypto coin none of those has. Saved between sessions (`iconCache`), so they draw at once next time.
 * One stable function, so `TokenIcon`'s own cache holds.
 */
export const loadIcon: IconLoader = withIconCache((id, venue, market) =>
  marketLogo(venue, id, market, {
    venue: venueClient.marketIcon,
    bundled: bundledLogo,
    coin: coinClient.logo,
    price: cachedPrice,
  }),
);
