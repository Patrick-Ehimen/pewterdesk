import { MapSeg, t } from "@pewterdesk/ui";
import { useState } from "react";
import type { TraderRow, TraderSource } from "../../api/venueClient";
import { followedKeys, useActivity, useTraders } from "../../lib/traders";
import { ActivityFeed, Following } from "./Following";
import { BoardSwitches, type BoardView, DEFAULT_BOARD, Leaderboard } from "./Leaderboard";
import type { MyBook } from "./TraderSide";
import { TraderView } from "./TraderView";
import { WatchStatus } from "./WatchStatus";

// The Traders page (after the Top traders mockups, design/screens/93-96):
// Hyperliquid's and OKX's leaderboards, a trader's page, the traders the
// trader follows and what they did. It reads public data and places
// nothing: it never copies a trade.

const TABS = ["board", "following", "activity"] as const;
type Tab = (typeof TABS)[number];
const VIEW_KEY = "pd.traders.board";

function readView(): BoardView {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as Partial<BoardView> | null;
    if (!v) return DEFAULT_BOARD;
    return {
      source: v.source === "okx" ? "okx" : "hyperliquid",
      period: ["day", "week", "month", "allTime"].includes(String(v.period))
        ? (v.period as BoardView["period"])
        : DEFAULT_BOARD.period,
      sort: ["pnl", "roi", "accountValue", "volume", "winRate"].includes(String(v.sort))
        ? (v.sort as BoardView["sort"])
        : DEFAULT_BOARD.sort,
      minAccount: Number(v.minAccount) > 0 ? Number(v.minAccount) : DEFAULT_BOARD.minAccount,
    };
  } catch {
    return DEFAULT_BOARD;
  }
}

interface Opened {
  source: TraderSource;
  id: string;
  row?: TraderRow;
}

/** `mine`: your positions on the venue on screen, for a trader's "Against your account". */
export function TradersPage({ mine }: { mine?: MyBook }) {
  const { state } = useTraders();
  const moves = useActivity();
  const [tab, setTab] = useState<Tab>(() =>
    followedKeys(state).length > 0 ? "following" : "board",
  );
  const [view, setViewState] = useState<BoardView>(readView);
  const [opened, setOpened] = useState<Opened>();

  const setView = (next: BoardView) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // Kept for this session only.
    }
  };
  const open = (source: TraderSource, id: string, row?: TraderRow) =>
    setOpened({ source, id, row });

  return (
    <div className="page traders">
      <header className="tr-head">
        <h1>{t("nav.traders")}</h1>
        <MapSeg
          options={TABS}
          value={tab}
          onChange={(next) => {
            setTab(next);
            setOpened(undefined);
          }}
          label={t("nav.traders")}
          text={(o) =>
            o === "following"
              ? `${t("traders.tab.following")} ${followedKeys(state).length || ""}`.trim()
              : t(`traders.tab.${o}`)
          }
        />
        <span className="app-spacer" />
        {tab === "board" && !opened && <BoardSwitches view={view} onView={setView} />}
        {tab !== "board" && <WatchStatus />}
      </header>
      {opened ? (
        <TraderView
          key={`${opened.source}:${opened.id}`}
          source={opened.source}
          id={opened.id}
          row={opened.row}
          period={view.source === opened.source ? view.period : "month"}
          mine={mine}
          onBack={() => setOpened(undefined)}
        />
      ) : tab === "board" ? (
        <Leaderboard view={view} onView={setView} onOpen={(r) => open(r.source, r.id, r)} />
      ) : tab === "following" ? (
        <Following onOpen={open} onBrowse={() => setTab("board")} />
      ) : (
        <ActivityFeed moves={moves} onOpen={open} />
      )}
    </div>
  );
}
