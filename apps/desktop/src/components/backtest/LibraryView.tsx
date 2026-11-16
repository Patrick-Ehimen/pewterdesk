import { EquityChart, type EquityLine, SparkChart, TokenIcon, t } from "@pewterdesk/ui";
import { type ReactNode, useMemo, useState } from "react";
import {
  LuChartNoAxesCombined,
  LuCopy,
  LuLayers,
  LuListChecks,
  LuPencil,
  LuPlay,
  LuPlus,
  LuTrash2,
  LuTrendingUp,
} from "react-icons/lu";
import { allMarkets, type LabStrategy, periodRange, type Template } from "../../lib/backtestLab";
import { VENUES } from "../../lib/venues";
import { day, marketName, money, pct, Seg, Sentence, tone, useVenueMarkets } from "./parts";

type Filter = "all" | "active" | "drafts";

const TEMPLATE_ICON: Record<Template, ReactNode> = {
  ema: <LuTrendingUp size={15} aria-hidden />,
  grid: <LuLayers size={15} aria-hidden />,
  dca: <LuChartNoAxesCombined size={15} aria-hidden />,
  custom: <LuListChecks size={15} aria-hidden />,
};

/** The markets a strategy is tested on, by the names the venue lists. */
function MarketsText({ s }: { s: LabStrategy }) {
  const markets = useVenueMarkets(s.venue);
  return (
    <>
      {allMarkets(s)
        .map((id) => marketName(markets, id))
        .join(", ")}
    </>
  );
}

/**
 * A strategy in the list: what it is, the markets it's tested on, how its
 * last run went and whether it has been run. Running is the side panel's.
 */
function Row({
  s,
  selected,
  running,
  onSelect,
}: {
  s: LabStrategy;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  const markets = useVenueMarkets(s.venue);
  const tested = allMarkets(s);
  const state = running ? "running" : s.last ? "tested" : "notRun";
  return (
    <button
      type="button"
      className={`lab-lib-row${selected ? " sel" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="lab-lib-icon">{TEMPLATE_ICON[s.strategy.template]}</span>
      <span className="lab-lib-name">
        <span className="lab-lib-title">
          <b>{s.name}</b>
          <span className="lab-pill">v{s.version}</span>
          {s.active && <span className="lab-pill brass">{t("bt.lib.active")}</span>}
        </span>
        <span className="lab-lib-desc">
          <Sentence config={s.strategy} />
        </span>
      </span>
      <span className="lab-lib-mkts" title={tested.map((id) => marketName(markets, id)).join(", ")}>
        {tested.slice(0, 3).map((id) => {
          const m = markets?.find((x) => x.id === id);
          return (
            <i key={id}>
              <TokenIcon market={m} size={14} />
              {m?.base ?? id}
            </i>
          );
        })}
        {tested.length > 3 && <i className="more">+{tested.length - 3}</i>}
        <small>
          {VENUES[s.venue].label} · {s.interval}
        </small>
      </span>
      <span className="lab-lib-res">
        {s.last ? (
          <>
            <span className={tone(s.last.ret)}>{pct(s.last.ret)}</span>
            <small>
              {s.holdOutDays > 0
                ? `${t("bt.lib.heldOut")} ${pct(s.last.retOut)}`
                : t("bt.lib.noHoldOut")}
            </small>
          </>
        ) : (
          <span className="lab-dim">–</span>
        )}
      </span>
      <span className={`lab-lib-state ${state}`}>
        <i />
        {t(`bt.lib.state.${state}`)}
        {s.last && <SparkChart times={s.last.times} values={s.last.curve} />}
        {s.last && <small>{day(s.last.at)}</small>}
      </span>
    </button>
  );
}

export function LibraryView({
  strategies,
  selectedId,
  running,
  onSelect,
  onRun,
  onEdit,
  onNew,
  onDuplicate,
  onDelete,
  onToggleActive,
}: {
  strategies: readonly LabStrategy[];
  selectedId?: string;
  running: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  /** Opens the start screen. */
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleActive: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...strategies]
      .filter((s) => (filter === "active" ? s.active : filter === "drafts" ? !s.last : true))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.market.toLowerCase().includes(q))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
  }, [strategies, filter, query]);
  const sel = strategies.find((s) => s.id === selectedId) ?? shown[0];
  const range = sel ? periodRange(sel) : undefined;
  const lines = useMemo<EquityLine[]>(
    () => (sel?.last ? [{ label: sel.name, values: sel.last.curve, color: "brass" }] : []),
    [sel],
  );

  return (
    <div className="lab-lib">
      <section className="lab-panel">
        <div className="lab-toolbar">
          <input
            className="lab-search"
            placeholder={t("bt.lib.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Seg
            label={t("bt.lib.filter")}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("bt.lib.all", { n: strategies.length }) },
              {
                value: "active",
                label: t("bt.lib.activeN", { n: strategies.filter((s) => s.active).length }),
              },
              {
                value: "drafts",
                label: t("bt.lib.notRunN", { n: strategies.filter((s) => !s.last).length }),
              },
            ]}
          />
          <button type="button" className="lab-btn primary" onClick={onNew}>
            <LuPlus size={12} aria-hidden />
            {t("bt.lib.new")}
          </button>
        </div>
        <div className="lab-lib-list">
          {shown.map((s) => (
            <Row
              key={s.id}
              s={s}
              selected={s.id === sel?.id}
              running={running.has(s.id)}
              onSelect={() => onSelect(s.id)}
            />
          ))}
          {shown.length === 0 && <p className="lab-empty">{t("bt.lib.none")}</p>}
        </div>
      </section>

      {sel ? (
        <section className="lab-panel lab-lib-detail">
          <div className="lab-detail-head">
            <div className="lab-lib-title">
              <h2>{sel.name}</h2>
              <span className="lab-pill">v{sel.version}</span>
              <label className="lab-switch">
                <input
                  type="checkbox"
                  checked={sel.active}
                  onChange={() => onToggleActive(sel.id)}
                />
                <span>{t("bt.lib.active")}</span>
              </label>
            </div>
            <p className="lab-sentence">
              <Sentence config={sel.strategy} />
            </p>
            {range && (
              <span className="lab-dim">
                <MarketsText s={sel} /> · {VENUES[sel.venue].label} · {sel.interval} ·{" "}
                {day(range.since)} – {day(range.until)}
                {sel.holdOutDays > 0 ? ` · ${t("bt.lib.holdOut", { n: sel.holdOutDays })}` : ""}
              </span>
            )}
          </div>
          {sel.last ? (
            <>
              <div className="lab-tiles four">
                <div className="lab-tile">
                  <span>{t("bt.v.return")}</span>
                  <b className={tone(sel.last.ret)}>{pct(sel.last.ret)}</b>
                  <small>
                    {t("bt.v.holding")} {pct(sel.last.buyHold)}
                  </small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.v.heldOut")}</span>
                  <b className={tone(sel.last.retOut)}>{pct(sel.last.retOut)}</b>
                  <small>{t("bt.v.neverSeen")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.v.maxDd")}</span>
                  <b>{pct(sel.last.maxDrawdown)}</b>
                  <small>{t("bt.v.fromHigh")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.v.trades")}</span>
                  <b>{sel.last.trades}</b>
                  <small>{day(sel.last.at)}</small>
                </div>
              </div>
              <div className="lab-lib-chart">
                <EquityChart
                  times={sel.last.times}
                  lines={lines}
                  drawdownOf={-1}
                  money={(v) => money(v)}
                />
              </div>
            </>
          ) : (
            <div className="lab-empty">
              <p>{t("bt.lib.notRunBody")}</p>
            </div>
          )}
          <div className="lab-detail-actions">
            <button
              type="button"
              className="lab-btn primary"
              disabled={running.has(sel.id)}
              onClick={() => onRun(sel.id)}
            >
              <LuPlay size={13} aria-hidden />
              {running.has(sel.id) ? t("bt.running") : t("bt.runBacktest")}
            </button>
            <button type="button" className="lab-btn" onClick={() => onEdit(sel.id)}>
              <LuPencil size={12} aria-hidden />
              {t("bt.lib.edit")}
            </button>
            <button type="button" className="lab-btn" onClick={() => onDuplicate(sel.id)}>
              <LuCopy size={12} aria-hidden />
              {t("bt.lib.duplicate")}
            </button>
            {confirmDelete ? (
              <button
                type="button"
                className="lab-btn danger"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(sel.id);
                }}
              >
                {t("bt.lib.deleteSure")}
              </button>
            ) : (
              <button type="button" className="lab-btn" onClick={() => setConfirmDelete(true)}>
                <LuTrash2 size={12} aria-hidden />
                {t("bt.lib.delete")}
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="lab-panel lab-empty">{t("bt.lib.none")}</section>
      )}
    </div>
  );
}
