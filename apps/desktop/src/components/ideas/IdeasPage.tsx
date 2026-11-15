import { venueLogos } from "@pewterdesk/assets";
import type { CandleInterval, Market, VenueId } from "@pewterdesk/core";
import { dateFormat, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import {
  LuArchive,
  LuChartCandlestick,
  LuCheck,
  LuLock,
  LuPencil,
  LuPlus,
  LuRotateCcw,
  LuSearch,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { useIdeaPrices } from "../../hooks/useIdeaPrices";
import { useIdeas } from "../../hooks/useIdeas";
import { useCloudAuth } from "../../hooks/useJournal";
import type { RecordPeriod } from "../../lib/ideaStats";
import {
  BIASES,
  type Bias,
  byCloseness,
  distance,
  ENTRY_NOW,
  type Idea,
  type IdeaStatus,
  MAX_TEXT,
  MAX_THOUGHTS,
  matches,
  nearest,
  newIdea,
  oddsTotal,
  rewardRisk,
  STATUSES,
  withStatus,
} from "../../lib/ideas";
import { VENUES } from "../../lib/venues";
import { CloudGate } from "../plan/CloudGate";
import { Attachments } from "../plan/TradeDetail";
import { Segmented } from "../rules/parts";
import { IdeaEditor } from "./IdeaEditor";
import { IdeasEmptyList, IdeasGuide, IdeasLoading } from "./IdeasEmpty";
import {
  BiasPill,
  Conviction,
  IDEA_INTERVALS,
  IdeaChart,
  IdeaToken,
  LevelBell,
  levelColor,
  price as priceText,
  RiskBar,
  signedPct,
} from "./parts";
import { TrackRecord } from "./TrackRecord";

const day = dateFormat({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "2d", "5h", "12m": how long ago. */
function since(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

interface IdeasPageProps {
  /** The venues in the terminal, for a new idea's market. */
  venues: readonly { id: VenueId; label: string }[];
  /** The venue and market on screen: where a new idea starts. */
  venue: VenueId;
  market?: Market;
  onOpenTrade: (venue: VenueId, market: string) => void;
  /** An idea to open on, asked for elsewhere (the Trade chart's chip, the Ideas panel). */
  focus?: { id: string; key: number };
}

/**
 * Coins the trader is watching: what they think each will do and why, the
 * levels that matter drawn on its chart, and their thoughts and screenshots
 * as it plays out. Kept in PewterDesk Cloud, apart from the journal and
 * trades; it reads prices and places nothing.
 */
export function IdeasPage({ venues, venue, market, onOpenTrade, focus }: IdeasPageProps) {
  const cloud = useCloudAuth(true);
  const signedIn = cloud.auth.state === "signedIn";
  const { ideas, load, saveError, save, remove } = useIdeas(signedIn, cloud.lost);
  // A list of ideas by where they stand, or the track record.
  const [tab, setTab] = useState<IdeaStatus | "record">("watching");
  const [period, setPeriod] = useState<RecordPeriod>("90d");
  const [bias, setBias] = useState<Bias | "all">("all");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string>();
  const [editing, setEditing] = useState<{ idea: Idea; isNew: boolean }>();
  const used = useMemo(() => new Set(ideas.map((i) => i.venue)), [ideas]);
  const priceOf = useIdeaPrices(used);
  const now = Date.now();
  const open = (idea: Idea) => {
    setPicked(idea.id);
    setTab(idea.status);
  };
  // Asked to open on one: its list, and it picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request
  useEffect(() => {
    const idea = focus && ideas.find((i) => i.id === focus.id);
    if (idea) open(idea);
  }, [focus?.key, ideas.length]);

  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, ideas.filter((i) => i.status === s).length]),
  ) as Record<IdeaStatus, number>;
  const shown = byCloseness(
    ideas.filter(
      (i) => i.status === tab && (bias === "all" || i.bias === bias) && matches(i, search),
    ),
    priceOf,
  );
  const current = shown.find((i) => i.id === picked) ?? shown[0];
  // The list is empty only because of the bias filter or the search.
  const filtered = tab !== "record" && shown.length === 0 && counts[tab] > 0;

  const startNew = () =>
    setEditing({
      idea: newIdea(crypto.randomUUID(), venue, market?.id ?? "", market?.symbol ?? ""),
      isNew: true,
    });

  if (!signedIn) {
    return (
      <div className="page ideas">
        <CloudGate cloud={cloud} />
      </div>
    );
  }

  return (
    <div className="page ideas">
      <div className="ideas-bar">
        <h1>{t("nav.ideas")}</h1>
        <nav className="ideas-tabs" aria-label={t("nav.ideas")}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-current={tab === s ? "page" : undefined}
              onClick={() => setTab(s)}
            >
              {t(`ideas.tab.${s}`)}
              <span className="ideas-count">{counts[s]}</span>
            </button>
          ))}
          <button
            type="button"
            aria-current={tab === "record" ? "page" : undefined}
            onClick={() => setTab("record")}
          >
            {t("ideas.tab.record")}
          </button>
        </nav>
        <div style={{ flex: 1 }} />
        <span className="ideas-private">
          <LuLock size={12} aria-hidden />
          {t("ideas.private")}
        </span>
        <Segmented
          label={t("ideas.editor.bias")}
          value={bias}
          options={[
            { value: "all" as const, label: t("ideas.filter.all") },
            ...BIASES.map((b) => ({ value: b, label: t(`ideas.bias.${b}`) })),
          ]}
          onChange={setBias}
        />
        <label className="ideas-search">
          <LuSearch size={13} aria-hidden />
          <input
            aria-label={t("ideas.search")}
            placeholder={t("ideas.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button type="button" className="rules-button rules-primary ideas-new" onClick={startNew}>
          <LuPlus size={14} aria-hidden />
          {t("ideas.new")}
        </button>
      </div>
      {saveError && <p className="ideas-error">{t("ideas.saveFailed", { error: saveError })}</p>}

      {load.state === "loading" ? (
        <IdeasLoading label={t("ideas.loading")} />
      ) : load.state === "error" ? (
        <p className="ideas-empty ideas-error">{load.error}</p>
      ) : ideas.length === 0 ? (
        <div className="ideas-empty-pane ideas-first-pane">
          <IdeasEmptyList
            status="watching"
            watching={0}
            onWatching={() => setTab("watching")}
            onNew={startNew}
          />
          <IdeasGuide />
        </div>
      ) : tab === "record" ? (
        <TrackRecord
          ideas={ideas}
          period={period}
          onPeriod={setPeriod}
          onOpen={open}
          onWatching={() => setTab("watching")}
        />
      ) : (
        <div className="ideas-grid">
          <section className="ideas-panel ideas-list" aria-label={t(`ideas.tab.${tab}`)}>
            <div className="ideas-list-head">
              <span>{t("ideas.sorted")}</span>
              <span>{shown.length}</span>
            </div>
            {shown.length === 0 && (
              <p className="ideas-hint ideas-pad">
                {t(filtered ? "ideas.empty.filtered" : "ideas.empty.none")}
              </p>
            )}
            {shown.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                price={priceOf(idea)}
                now={now}
                selected={idea.id === current?.id}
                onPick={() => setPicked(idea.id)}
              />
            ))}
          </section>
          {current ? (
            <IdeaDetail
              key={current.id}
              idea={current}
              price={priceOf(current)}
              onChange={save}
              onEdit={() => setEditing({ idea: current, isNew: false })}
              onDelete={() => remove(current)}
              onOpenTrade={() => onOpenTrade(current.venue, current.market)}
            />
          ) : (
            <div className="ideas-empty-pane">
              {filtered ? (
                <div className="ideas-empty-card">
                  <h3>{t("ideas.empty.filteredTitle")}</h3>
                  <p>{t("ideas.empty.filteredBody")}</p>
                  <div className="ideas-empty-actions">
                    <button
                      type="button"
                      className="rules-button"
                      onClick={() => {
                        setBias("all");
                        setSearch("");
                      }}
                    >
                      {t("ideas.empty.clearFilters")}
                    </button>
                  </div>
                </div>
              ) : (
                <IdeasEmptyList
                  status={tab}
                  watching={counts.watching}
                  onWatching={() => setTab("watching")}
                  onNew={startNew}
                />
              )}
              <IdeasGuide />
            </div>
          )}
        </div>
      )}

      {editing && (
        <IdeaEditor
          idea={editing.idea}
          isNew={editing.isNew}
          venues={venues}
          onCancel={() => setEditing(undefined)}
          onSave={(idea) => {
            save(idea, true);
            setPicked(idea.id);
            setTab(idea.status);
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

/** One idea in the list: its market, bias, thesis, price and where it stands. */
function IdeaCard({
  idea,
  price,
  now,
  selected,
  onPick,
}: {
  idea: Idea;
  price?: number;
  now: number;
  selected: boolean;
  onPick: () => void;
}) {
  const near = nearest(idea, price);
  const moved = price && idea.notedPrice ? distance(idea.notedPrice, price) : undefined;
  return (
    <button type="button" className="ideas-card" aria-pressed={selected} onClick={onPick}>
      <span className="ideas-card-row">
        <IdeaToken venue={idea.venue} market={idea.market} symbol={idea.symbol} />
        <span className="ideas-card-name">
          <b>{idea.symbol}</b>
          <small>
            <img className="ideas-venue-logo" src={venueLogos[idea.venue]} alt="" />
            {VENUES[idea.venue].label} · {t("ideas.ago", { time: since(idea.notedAt, now) })}
          </small>
        </span>
        <BiasPill bias={idea.bias} />
      </span>
      {idea.thesis && <span className="ideas-card-thesis">{idea.thesis}</span>}
      <span className="ideas-card-row ideas-card-foot">
        <span className="pd-num">
          {price ? priceText(price) : "–"}
          {moved !== undefined && (
            <em className={moved >= 0 ? "pd-up" : "pd-down"}> {signedPct(moved)}</em>
          )}
        </span>
        <span className="ideas-standing">
          {near && (
            <>
              <i className="ideas-swatch" style={{ background: levelColor(near.level.color) }} />
              {t("ideas.toLevel", {
                pct: signedPct(near.share),
                name: near.level.name || t("ideas.unnamed"),
              })}
            </>
          )}
        </span>
        <Conviction value={idea.conviction} />
      </span>
    </button>
  );
}

/** The idea picked: its chart and levels, thesis, thoughts and screenshots, and what to do with it. */
function IdeaDetail({
  idea,
  price,
  onChange,
  onEdit,
  onDelete,
  onOpenTrade,
}: {
  idea: Idea;
  price?: number;
  onChange: (idea: Idea, now?: boolean) => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
  onOpenTrade: () => void;
}) {
  const [interval, setChartInterval] = useState<CandleInterval>("4h");
  const [thought, setThought] = useState("");
  const [deleting, setDeleting] = useState<"asking" | "busy">();
  const [deleteError, setDeleteError] = useState<string>();
  const moved = price && idea.notedPrice ? distance(idea.notedPrice, price) : undefined;
  const rr = rewardRisk(idea, price);
  const entryName =
    idea.risk.entry === ENTRY_NOW
      ? t("ideas.rr.now")
      : idea.levels.find((l) => l.id === idea.risk.entry)?.name || undefined;
  const levels = [...idea.levels].sort((a, b) => b.price - a.price);
  // Thoughts are numbered in the order they were written, pinned to the chart by that number.
  const pins = idea.thoughts.map((th, i) => ({ at: th.at, label: String(i + 1) }));

  const addThought = () => {
    const body = thought.trim().slice(0, MAX_TEXT);
    if (!body) return;
    const next = {
      id: crypto.randomUUID(),
      at: Date.now(),
      price,
      text: body,
    };
    onChange({ ...idea, thoughts: [...idea.thoughts, next].slice(-MAX_THOUGHTS) }, true);
    setThought("");
  };
  const setStatus = (status: IdeaStatus) => onChange(withStatus(idea, status, price), true);

  return (
    <>
      <section className="ideas-panel ideas-detail">
        <header className="ideas-detail-head">
          <IdeaToken venue={idea.venue} market={idea.market} symbol={idea.symbol} size={34} />
          <div className="ideas-detail-title">
            <h2>
              {idea.symbol}{" "}
              <small>
                <img className="ideas-venue-logo" src={venueLogos[idea.venue]} alt="" />
                {VENUES[idea.venue].label}
              </small>
            </h2>
            <span className="ideas-hint">
              {idea.notedPrice
                ? t("ideas.noted", {
                    date: day.format(idea.notedAt),
                    price: priceText(idea.notedPrice),
                  })
                : t("ideas.notedNoPrice", { date: day.format(idea.notedAt) })}
            </span>
          </div>
          <BiasPill bias={idea.bias} />
          <span className="ideas-tag">{t(`ideas.tf.${idea.timeframe}`)}</span>
          {idea.tags.map((tag) => (
            <span key={tag} className="ideas-tag">
              #{tag}
            </span>
          ))}
          <div style={{ flex: 1 }} />
          <div className="ideas-now">
            <b className="pd-num">{price ? priceText(price) : "–"}</b>
            {moved !== undefined && (
              <small className={moved >= 0 ? "pd-up" : "pd-down"}>
                {t("ideas.since", { pct: signedPct(moved) })}
              </small>
            )}
          </div>
        </header>
        <div className="ideas-chart-bar">
          <Segmented
            label={t("ideas.timeframe")}
            value={interval}
            options={IDEA_INTERVALS.map((i) => ({ value: i, label: i.toUpperCase() }))}
            onChange={setChartInterval}
          />
        </div>
        <IdeaChart
          venue={idea.venue}
          market={idea.market}
          symbol={idea.symbol}
          interval={interval}
          levels={idea.levels}
          pins={pins}
        />

        <div className="ideas-detail-scroll">
          <section className="ideas-sec">
            <h3>
              {t("ideas.thesis")}
              <button type="button" className="rules-link" onClick={onEdit}>
                {t("ideas.edit")}
              </button>
            </h3>
            {idea.thesis ? <p className="ideas-thesis">{idea.thesis}</p> : null}
            {(idea.wrongIf || idea.catalysts) && (
              <div className="ideas-paras">
                {idea.wrongIf && (
                  <div className="ideas-para">
                    <h4>{t("ideas.wrongIf")}</h4>
                    <p>{idea.wrongIf}</p>
                  </div>
                )}
                {idea.catalysts && (
                  <div className="ideas-para">
                    <h4>{t("ideas.catalysts")}</h4>
                    <p>{idea.catalysts}</p>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="ideas-sec">
            <h3>
              {t("ideas.thoughts")}
              <span>{t("ideas.thoughtsCount", { n: idea.thoughts.length })}</span>
            </h3>
            <form
              className="ideas-add"
              onSubmit={(e) => {
                e.preventDefault();
                addThought();
              }}
            >
              <LuPlus size={13} aria-hidden />
              <input
                aria-label={t("ideas.addThought")}
                placeholder={t("ideas.addThought")}
                maxLength={MAX_TEXT}
                value={thought}
                onChange={(e) => setThought(e.target.value)}
              />
              <button type="submit" className="rules-button" disabled={!thought.trim()}>
                {t("ideas.add")}
              </button>
            </form>
            <ol className="ideas-thoughts">
              {idea.thoughts
                .map((th, i) => ({ th, n: i + 1 }))
                .reverse()
                .map(({ th, n }) => (
                  <li key={th.id}>
                    <span className="ideas-pin">{n}</span>
                    <div>
                      <p>{th.text}</p>
                      <small>
                        {th.price
                          ? t("ideas.thoughtAt", {
                              date: day.format(th.at),
                              price: priceText(th.price),
                            })
                          : day.format(th.at)}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="pd-icon-button"
                      aria-label={t("ideas.removeThought")}
                      onClick={() =>
                        onChange(
                          { ...idea, thoughts: idea.thoughts.filter((x) => x.id !== th.id) },
                          true,
                        )
                      }
                    >
                      <LuX size={12} aria-hidden />
                    </button>
                  </li>
                ))}
            </ol>
          </section>

          <section className="ideas-sec">
            <Attachments
              paths={idea.shots}
              onChange={(shots) => onChange({ ...idea, shots }, true)}
            />
          </section>
        </div>
      </section>

      <aside className="ideas-panel ideas-side">
        <div className="ideas-side-head">
          <h2>{t("ideas.levels")}</h2>
          {price && (
            <span className="ideas-hint">{t("ideas.levelsFrom", { price: priceText(price) })}</span>
          )}
        </div>
        {levels.length === 0 && <p className="ideas-hint ideas-pad">{t("ideas.noLevels")}</p>}
        <ul className="ideas-levels">
          {levels.map((l) => (
            <li key={l.id}>
              <span className="ideas-swatch" style={{ background: levelColor(l.color) }} />
              <b className={l.name ? undefined : "ideas-unnamed"}>{l.name || t("ideas.unnamed")}</b>
              <span className="pd-num">{priceText(l.price)}</span>
              <span className="pd-num ideas-dist">
                {price ? signedPct(distance(price, l.price)) : "–"}
              </span>
              <LevelBell
                on={l.alert}
                name={l.name || t("ideas.unnamed")}
                onChange={(alert) =>
                  onChange(
                    {
                      ...idea,
                      levels: idea.levels.map((x) => (x.id === l.id ? { ...x, alert } : x)),
                    },
                    true,
                  )
                }
              />
            </li>
          ))}
        </ul>

        <dl className="ideas-read">
          <dt>{t("ideas.conviction")}</dt>
          <dd>
            <Conviction value={idea.conviction} />
          </dd>
          <dt>{t("ideas.timeframe")}</dt>
          <dd>{t(`ideas.tf.${idea.timeframe}`)}</dd>
        </dl>

        <div className="ideas-side-head">
          <h2>{t("ideas.rr")}</h2>
          {rr && entryName && (
            <span className="ideas-hint">{t("ideas.rr.from", { name: entryName })}</span>
          )}
        </div>
        <div className="ideas-pad-x">
          {rr ? <RiskBar rr={rr} /> : <p className="ideas-hint">{t("ideas.rr.none")}</p>}
        </div>

        {idea.scenarios.length > 0 && (
          <>
            <div className="ideas-side-head">
              <h2>{t("ideas.scenarios")}</h2>
              {oddsTotal(idea.scenarios) !== 100 && (
                <span className="ideas-hint ideas-warn">
                  {t("ideas.odds.off", { total: oddsTotal(idea.scenarios) })}
                </span>
              )}
            </div>
            <ul className="ideas-scenarios">
              {idea.scenarios.map((sc) => (
                <li key={sc.id}>
                  <b>{sc.title}</b>
                  <span className="pd-num">{sc.odds}%</span>
                  {sc.text && <p>{sc.text}</p>}
                  <i className="ideas-odds" style={{ width: `${sc.odds}%` }} />
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="ideas-side-head">
          <h2>{t("ideas.status")}</h2>
        </div>
        <div className="ideas-actions">
          {idea.status === "watching" ? (
            <>
              <button type="button" className="rules-button" onClick={() => setStatus("playedOut")}>
                <LuCheck size={13} aria-hidden />
                {t("ideas.markPlayedOut")}
              </button>
              <button type="button" className="rules-button" onClick={() => setStatus("wrong")}>
                <LuX size={13} aria-hidden />
                {t("ideas.markWrong")}
              </button>
              <button type="button" className="rules-button" onClick={() => setStatus("archived")}>
                <LuArchive size={13} aria-hidden />
                {t("ideas.archive")}
              </button>
            </>
          ) : (
            <button type="button" className="rules-button" onClick={() => setStatus("watching")}>
              <LuRotateCcw size={13} aria-hidden />
              {t("ideas.reopen")}
            </button>
          )}
        </div>

        <div className="ideas-side-foot">
          <button type="button" className="rules-button" onClick={onOpenTrade}>
            <LuChartCandlestick size={13} aria-hidden />
            {t("ideas.openOnTrade")}
          </button>
          <button type="button" className="rules-button" onClick={onEdit}>
            <LuPencil size={13} aria-hidden />
            {t("ideas.edit")}
          </button>
          {deleting ? (
            <div className="ideas-confirm" role="alert">
              <p>{t("ideas.deleteConfirm")}</p>
              {deleteError && <p className="ideas-error">{deleteError}</p>}
              <div>
                <button
                  type="button"
                  className="rules-button"
                  disabled={deleting === "busy"}
                  onClick={() => setDeleting(undefined)}
                >
                  {t("ideas.editor.cancel")}
                </button>
                <button
                  type="button"
                  className="rules-button rules-danger"
                  disabled={deleting === "busy"}
                  onClick={() => {
                    setDeleting("busy");
                    setDeleteError(undefined);
                    onDelete().catch((e: Error) => {
                      setDeleteError(e.message);
                      setDeleting("asking");
                    });
                  }}
                >
                  {t("ideas.deleteNow")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="pd-icon-button ideas-delete"
              aria-label={t("ideas.delete")}
              title={t("ideas.delete")}
              onClick={() => setDeleting("asking")}
            >
              <LuTrash2 size={14} aria-hidden />
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
