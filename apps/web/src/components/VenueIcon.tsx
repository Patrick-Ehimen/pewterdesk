// A venue's own mark from assets/venues, on a rounded tile. Most come with
// their tile; Hyperliquid's and Aster's are bare marks drawn for a dark
// background, so those sit on the dark palette's.
import aster from "@pewterdesk/assets/venues/aster.svg";
import backpack from "@pewterdesk/assets/venues/backpack.svg";
import binance from "@pewterdesk/assets/venues/binance.svg";
import bitget from "@pewterdesk/assets/venues/bitget.svg";
import bybit from "@pewterdesk/assets/venues/bybit.svg";
import coinbase from "@pewterdesk/assets/venues/coinbase.svg";
import dydx from "@pewterdesk/assets/venues/dydx.svg";
import gmx from "@pewterdesk/assets/venues/gmx.svg";
import hyperliquid from "@pewterdesk/assets/venues/hyperliquid.svg";
import kraken from "@pewterdesk/assets/venues/kraken.svg";
import kucoin from "@pewterdesk/assets/venues/kucoin.svg";
import okx from "@pewterdesk/assets/venues/okx.svg";

const icons = {
  aster,
  backpack,
  binance,
  bitget,
  bybit,
  coinbase,
  dydx,
  gmx,
  hyperliquid,
  kraken,
  kucoin,
  okx,
};

export type VenueIconId = keyof typeof icons;

const bare: readonly VenueIconId[] = ["hyperliquid", "aster"];

export function VenueIcon({ id, small }: { id: VenueIconId; small?: boolean }) {
  const isBare = bare.includes(id);
  return (
    <span
      className={`ed-venue-icon${small ? " is-small" : ""}${isBare ? " is-bare" : ""}`}
      data-theme={isBare ? "dark" : undefined}
    >
      <img src={icons[id]} alt="" width={24} height={24} />
    </span>
  );
}
