import type { Market } from "@pewterdesk/core";
import {
  formatNumber,
  Hint,
  type MessageKey,
  SummarySkeleton,
  Tabs,
  Tooltip,
  t,
} from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";
import { FaGithub, FaRedditAlien, FaTelegram, FaXTwitter } from "react-icons/fa6";
import {
  LuChevronsDown,
  LuChevronsUp,
  LuFileText,
  LuGlobe,
  LuMessagesSquare,
} from "react-icons/lu";
import { type CoinInfo, type CoinLink, type CoinLinkKind, coinClient } from "../../api/venueClient";
import { useCoinInfo } from "../../hooks/useVenueFeeds";
import { cachedPrice } from "../../lib/cachedPrices";
import { isAnotherCoin, isCryptoMarket } from "../../lib/marketIcons";
import { DEFAULT_VIEW_PREFS, type ViewPrefs } from "../../lib/viewPrefs";

type Section = "info" | "fundraising" | "tokenomics";

/** Descriptions longer than this start folded. */
const FOLD_AT = 280;

const SOCIAL_ICON: Partial<Record<CoinLinkKind, ReactNode>> = {
  github: <FaGithub size={18} aria-hidden />,
  x: <FaXTwitter size={16} aria-hidden />,
  reddit: <FaRedditAlien size={17} aria-hidden />,
  telegram: <FaTelegram size={17} aria-hidden />,
};

const SOCIAL_LABEL: Partial<Record<CoinLinkKind, MessageKey>> = {
  github: "coin.github",
  x: "coin.x",
  reddit: "coin.reddit",
  telegram: "coin.telegram",
};

const OFFICIAL: Partial<Record<CoinLinkKind, { label: MessageKey; icon: ReactNode }>> = {
  website: { label: "coin.website", icon: <LuGlobe size={15} aria-hidden /> },
  whitepaper: { label: "coin.whitepaper", icon: <LuFileText size={15} aria-hidden /> },
  forum: { label: "coin.forum", icon: <LuMessagesSquare size={15} aria-hidden /> },
};

/** "No data available", as an empty section says it. */
function NoData() {
  return (
    <div className="coin-empty">
      <LuFileText size={34} aria-hidden />
      <p>{t("coin.noData")}</p>
    </div>
  );
}

/** Opens a link through Rust, which only opens what it fetched for this coin. */
const open = (info: CoinInfo, link: CoinLink) => {
  coinClient.open(info.id, link.index).catch(() => {});
};

function Detail({ label, hint, value }: { label: MessageKey; hint: MessageKey; value: string }) {
  return (
    <div>
      <dt>
        <Tooltip className="coin-hint" content={<Hint title={t(label)}>{t(hint)}</Hint>}>
          {t(label)}
        </Tooltip>
      </dt>
      <dd className="pd-num">{value}</dd>
    </div>
  );
}

function Info({ info, show }: { info: CoinInfo; show: ViewPrefs["overview"] }) {
  const [unfolded, setUnfolded] = useState(false);
  const usd = (v: number | null) => (v === null ? "-" : `$${formatNumber(v, 0)}`);
  const amount = (v: number | null) => (v === null ? "-" : formatNumber(v, 0));
  const foldable = info.description.length > FOLD_AT;
  const explorers = info.links.filter((l) => l.kind === "explorer");
  const socials = info.links.filter((l) => SOCIAL_ICON[l.kind]);
  const official = info.links.filter((l) => OFFICIAL[l.kind]);

  return (
    <div className="coin-info">
      <section className="coin-details" aria-labelledby="coin-details-title">
        <h3 id="coin-details-title">{t("coin.details")}</h3>
        <dl>
          <Detail label="coin.marketCap" hint="coin.marketCapHint" value={usd(info.marketCap)} />
          <Detail label="coin.fdv" hint="coin.fdvHint" value={usd(info.fdv)} />
        </dl>
        <dl>
          <Detail
            label="coin.circulating"
            hint="coin.circulatingHint"
            value={amount(info.circulatingSupply)}
          />
          <Detail label="coin.total" hint="coin.totalHint" value={amount(info.totalSupply)} />
          <Detail label="coin.max" hint="coin.maxHint" value={amount(info.maxSupply)} />
        </dl>
      </section>

      <div className="coin-side">
        {show.about && (
          <section aria-labelledby="coin-about-title">
            <h3 id="coin-about-title">{t("coin.about", { symbol: info.symbol })}</h3>
            {info.description ? (
              <>
                <p className="coin-about" data-folded={(foldable && !unfolded) || undefined}>
                  {info.description}
                </p>
                {foldable && (
                  <button
                    type="button"
                    className="coin-more"
                    onClick={() => setUnfolded((u) => !u)}
                  >
                    {t(unfolded ? "coin.showLess" : "coin.showMore")}
                    {unfolded ? (
                      <LuChevronsUp size={15} aria-hidden />
                    ) : (
                      <LuChevronsDown size={15} aria-hidden />
                    )}
                  </button>
                )}
              </>
            ) : (
              <p className="coin-none">{t("coin.noData")}</p>
            )}
          </section>
        )}

        {show.tags && info.tags.length > 0 && (
          <section aria-labelledby="coin-tags-title">
            <h3 id="coin-tags-title">{t("coin.tags")}</h3>
            <ul className="coin-chips">
              {info.tags.map((tag) => (
                <li key={tag} className="coin-chip">
                  {tag}
                </li>
              ))}
            </ul>
          </section>
        )}

        {show.links && explorers.length > 0 && (
          <section aria-labelledby="coin-explore-title">
            <h3 id="coin-explore-title">{t("coin.explore")}</h3>
            <ul className="coin-chips">
              {explorers.map((link) => (
                <li key={link.index}>
                  <button type="button" className="coin-chip" onClick={() => open(info, link)}>
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {show.socials && socials.length > 0 && (
          <section aria-labelledby="coin-socials-title">
            <h3 id="coin-socials-title">{t("coin.socials")}</h3>
            <ul className="coin-socials">
              {socials.map((link) => {
                const label = SOCIAL_LABEL[link.kind];
                return (
                  <li key={link.index}>
                    <button
                      type="button"
                      className="coin-social"
                      aria-label={label && t(label)}
                      title={label && t(label)}
                      onClick={() => open(info, link)}
                    >
                      {SOCIAL_ICON[link.kind]}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {show.links && official.length > 0 && (
          <section aria-labelledby="coin-links-title">
            <h3 id="coin-links-title">{t("coin.links")}</h3>
            <ul className="coin-chips">
              {official.map((link) => {
                const kind = OFFICIAL[link.kind];
                return (
                  <li key={link.index}>
                    <button
                      type="button"
                      className="coin-chip coin-link"
                      title={link.label}
                      onClick={() => open(info, link)}
                    >
                      {kind?.icon}
                      {kind && t(kind.label)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * The Markets panel's Overview: what the coin on screen is, from CoinGecko -
 * token details, about, tags, explorers, socials and official links. CoinGecko
 * has no fundraising or tokenomics data, so those say so. Markets that aren't
 * coins (HIP-3 stocks and the like) have no overview.
 */
export function CoinOverview({
  market,
  show = DEFAULT_VIEW_PREFS.overview,
}: {
  market?: Market;
  /** Which parts of the Info section show, as the tab's settings choose. */
  show?: ViewPrefs["overview"];
}) {
  const [section, setSection] = useState<Section>("info");
  // CoinGecko knows coins by ticker: a stock's would find an unrelated coin
  // (Bybit's PURR is a company's shares, not the memecoin).
  const base = isCryptoMarket(market) ? market.base : undefined;
  const feed = useCoinInfo(base);
  // And among coins, the best-known one with that ticker isn't always the
  // one traded here: it has to be worth what this market trades at.
  const wrongCoin =
    market !== undefined &&
    feed.status === "live" &&
    feed.data !== null &&
    isAnotherCoin(feed.data, market.base, cachedPrice(market.venue, market.id));

  const body = (() => {
    if (section !== "info" || !market || !base) return <NoData />;
    switch (feed.status) {
      case "idle":
      case "loading":
        return <SummarySkeleton rows={6} />;
      case "error":
        return (
          <div className="coin-empty">
            <p>{feed.message}</p>
          </div>
        );
      default:
        return feed.data && !wrongCoin ? <Info info={feed.data} show={show} /> : <NoData />;
    }
  })();

  return (
    <div className="app-fill coin-overview">
      <Tabs
        variant="sub"
        label={t("coin.sections")}
        tabs={[
          { id: "info", label: t("coin.info") },
          { id: "fundraising", label: t("coin.fundraising") },
          { id: "tokenomics", label: t("coin.tokenomics") },
        ]}
        active={section}
        onChange={setSection}
      />
      <div className="app-scroll coin-body">{body}</div>
    </div>
  );
}
