import { logo } from "@pewterdesk/assets";
import { dateFormat, t, toast, toastError } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import {
  LuBadgeCheck,
  LuBrain,
  LuChevronDown,
  LuCopy,
  LuMegaphone,
  LuMessageCircle,
  LuNewspaper,
  LuShare2,
  LuThumbsDown,
  LuThumbsUp,
  LuZap,
} from "react-icons/lu";
import { appClient } from "../../api/appClient";
import {
  type AiSource,
  type AiStep,
  aiClient,
  newsClient,
  wireClient,
} from "../../api/venueClient";
import type { ChatMessage } from "../../lib/aiChats";
import type { AiShareCard } from "../../lib/aiShareCard";
import { answerOf, type Block, copyText, plainOf, type Span, spansOf } from "../../lib/aiText";
import { AiShareDialog } from "./AiShareDialog";

/** A section heading's own number: "1. The initial shock" → 1. */
const NUMBERED = /^(\d{1,2})[.)]\s+/;
/** Section labels the layout asks for, drawn small rather than as a heading. */
const LABEL = /^deep dive$/i;

/**
 * One of the analyst's answers, laid out: what it read and how long it
 * took, its TLDR in a card, the deep dive in numbered sections, the bottom
 * line, the sources it cites (opened by Rust, by id), and copy, share and
 * thumbs. All of it text: nothing is read as markup, and no link comes
 * from the model.
 */
export function AiAnswer({
  message,
  question,
  model,
  toolLabel,
  onRate,
  compact = false,
}: {
  message: ChatMessage;
  /** The question it answers, for the share card. */
  question: string;
  /** The model's name, for the share card. */
  model: string;
  toolLabel: (name: string) => string;
  onRate?: (rating: "up" | "down") => void;
  compact?: boolean;
}) {
  const answer = useMemo(() => answerOf(message.text), [message.text]);
  const sources = message.sources ?? [];
  // Citations numbered 1, 2, 3 in the order the answer first cites them.
  const order = useMemo(() => {
    const seen: number[] = [];
    const visit = (spans: readonly Span[]) => {
      for (const s of spans)
        if (s.kind === "cite" && !seen.includes(s.n) && sources.some((x) => x.n === s.n))
          seen.push(s.n);
    };
    if (answer.tldr) {
      visit(answer.tldr.lead);
      for (const p of answer.tldr.points) visit(p);
    }
    for (const b of answer.body) {
      if (b.kind === "list") for (const item of b.items) visit(item);
      else visit(b.spans);
    }
    if (answer.bottom) visit(answer.bottom);
    return seen;
  }, [answer, sources]);
  const cited = order.flatMap((n) => sources.find((s) => s.n === n) ?? []);
  const numberOf = (n: number) => order.indexOf(n) + 1;
  const [sharing, setSharing] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(message.text, sources));
      toast({ title: t("ai.answer.copy"), body: t("ai.answer.copied") });
    } catch (err) {
      toastError(t("ai.answer.copy"), err, t("share.failed"));
    }
  };

  const card: AiShareCard = useMemo(() => {
    const firstText = answer.body.find((b) => b.kind === "paragraph");
    const firstList = answer.body.find((b) => b.kind === "list");
    return {
      question,
      lead: answer.tldr
        ? plainOf(answer.tldr.lead)
        : firstText && firstText.kind === "paragraph"
          ? plainOf(firstText.spans)
          : "",
      points: answer.tldr
        ? answer.tldr.points.map(plainOf)
        : firstList && firstList.kind === "list"
          ? firstList.items.map(plainOf)
          : [],
      label: t("ai.answer.tldr"),
      footer: `PewterDesk AI · ${model} · ${dateFormat({ dateStyle: "medium" }).format(message.time)}`,
      disclaimer: t("ai.answer.notAdvice"),
    };
  }, [answer, question, model, message.time]);

  const tools = [...new Set(message.tools ?? [])];

  return (
    <div className="ai-answer" data-compact={compact || undefined}>
      <ResearchHead
        message={message}
        tools={message.steps?.length ? [] : tools}
        toolLabel={toolLabel}
      />
      {message.steps && message.steps.length > 0 && (
        <Thinking steps={message.steps} took={message.took} toolLabel={toolLabel} />
      )}
      {answer.tldr && (
        <section className="ai-tldr" aria-label={t("ai.answer.tldr")}>
          <h3 className="ai-tldr-head">
            <LuZap size={15} aria-hidden />
            {t("ai.answer.tldr")}
          </h3>
          {answer.tldr.lead.length > 0 && (
            <p className="ai-tldr-lead">
              <Spans spans={answer.tldr.lead} numberOf={numberOf} sources={sources} />
            </p>
          )}
          {answer.tldr.points.length > 0 && (
            <ol className="ai-tldr-points">
              {answer.tldr.points.map((point, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: points don't move
                <li key={i}>
                  <span className="ai-num" aria-hidden>
                    {i + 1}
                  </span>
                  <span>
                    <Spans spans={point} numberOf={numberOf} sources={sources} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {answer.body.length > 0 && (
        <div className="ai-rich ai-dive">
          {answer.body.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks don't move
            <BlockView key={i} block={b} numberOf={numberOf} sources={sources} />
          ))}
        </div>
      )}
      {answer.bottom && (
        <p className="ai-bottom">
          <strong>{t("ai.answer.bottom")}</strong>{" "}
          <Spans spans={answer.bottom} numberOf={numberOf} sources={sources} />
        </p>
      )}
      <p className="ai-answer-note">{t("ai.answer.disclaimer")}</p>
      {cited.length > 0 && <SourceList sources={cited} />}
      <div className="ai-answer-actions">
        <button
          type="button"
          className="ai-act"
          title={t("ai.answer.copy")}
          aria-label={t("ai.answer.copy")}
          onClick={() => void copy()}
        >
          <LuCopy size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="ai-act"
          title={t("ai.answer.share")}
          aria-label={t("ai.answer.share")}
          onClick={() => setSharing(true)}
        >
          <LuShare2 size={15} aria-hidden />
        </button>
        {onRate && (
          <>
            <button
              type="button"
              className="ai-act"
              data-on={message.rating === "up" || undefined}
              aria-pressed={message.rating === "up"}
              title={t("ai.answer.good")}
              aria-label={t("ai.answer.good")}
              onClick={() => onRate("up")}
            >
              <LuThumbsUp size={15} aria-hidden />
            </button>
            <button
              type="button"
              className="ai-act"
              data-on={message.rating === "down" || undefined}
              aria-pressed={message.rating === "down"}
              title={t("ai.answer.bad")}
              aria-label={t("ai.answer.bad")}
              onClick={() => onRate("down")}
            >
              <LuThumbsDown size={15} aria-hidden />
            </button>
          </>
        )}
      </div>
      {sharing && (
        <AiShareDialog
          card={card}
          brandLogo={logo.horizontal.darkBg}
          onSave={appClient.saveShareImage}
          onShare={appClient.openShare}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}

/** "Research complete · 12s · 5 tools · 3 steps", and what it read, on request. */
function ResearchHead({
  message,
  tools,
  toolLabel,
}: {
  message: ChatMessage;
  tools: readonly string[];
  toolLabel: (name: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const facts = [
    message.took !== undefined
      ? t("ai.answer.took", { secs: Math.max(1, Math.round(message.took / 1000)) })
      : undefined,
    tools.length > 0
      ? t(tools.length === 1 ? "ai.answer.tool" : "ai.answer.tools", { count: tools.length })
      : undefined,
    message.rounds
      ? t(message.rounds === 1 ? "ai.answer.step" : "ai.answer.steps", { count: message.rounds })
      : undefined,
  ].filter(Boolean);
  if (facts.length === 0) return null;
  return (
    <div className="ai-research">
      <span className="ai-research-mark" aria-hidden>
        <LuBadgeCheck size={14} />
      </span>
      <strong>{t("ai.answer.done")}</strong>
      {facts.map((f) => (
        <span key={f} className="ai-research-fact">
          {f}
        </span>
      ))}
      {tools.length > 0 && (
        <button
          type="button"
          className="ai-research-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {t("ai.answer.detail")}
          <LuChevronDown size={14} aria-hidden data-open={open || undefined} />
        </button>
      )}
      {open && (
        <p className="ai-tools ai-research-tools">
          {tools.map((name) => (
            <span key={name}>{toolLabel(name)}</span>
          ))}
        </p>
      )}
    </div>
  );
}

function BlockView({
  block,
  numberOf,
  sources,
}: {
  block: Block;
  numberOf: (n: number) => number;
  sources: readonly AiSource[];
}) {
  if (block.kind === "heading") {
    const text = plainOf(block.spans);
    if (LABEL.test(text)) return <h3 className="ai-section-label">{text}</h3>;
    const numbered = NUMBERED.exec(text);
    if (numbered) {
      return (
        <h4 className="ai-section">
          <span className="ai-num" aria-hidden>
            {numbered[1]}
          </span>
          {text.replace(NUMBERED, "")}
        </h4>
      );
    }
    return block.level <= 2 ? (
      <h3 className="ai-heading">
        <Spans spans={block.spans} numberOf={numberOf} sources={sources} />
      </h3>
    ) : (
      <h4 className="ai-section">
        <Spans spans={block.spans} numberOf={numberOf} sources={sources} />
      </h4>
    );
  }
  if (block.kind === "paragraph")
    return (
      <p>
        <Spans spans={block.spans} numberOf={numberOf} sources={sources} />
      </p>
    );
  const List = block.ordered ? "ol" : "ul";
  return (
    <List>
      {block.items.map((item, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items don't move
        <li key={j}>
          <Spans spans={item} numberOf={numberOf} sources={sources} />
        </li>
      ))}
    </List>
  );
}

function Spans({
  spans,
  numberOf,
  sources,
}: {
  spans: readonly Span[];
  numberOf: (n: number) => number;
  sources: readonly AiSource[];
}) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === "cite") {
          const source = sources.find((x) => x.n === s.n);
          // A tag the answer has no source for (from an earlier answer, or made up) shows nothing.
          if (!source) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
            <Cite key={i} source={source} number={numberOf(s.n)} />
          );
        }
        if (s.kind === "bold")
          // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
          return <strong key={i}>{s.text}</strong>;
        if (s.kind === "code")
          // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
          return <code key={i}>{s.text}</code>;
        // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

/**
 * Opens a source in the browser: by the signed link Rust gave it (Rust
 * checks its own signature), or, for older answers, by the id its module
 * gave it. When that can't open any more, Rust finds the item again in the
 * feeds, or opens a search for it.
 */
async function openSource(source: AiSource) {
  try {
    if (source.open?.kind === "link") return await aiClient.openSource(source.open.id);
    if (source.open?.kind === "article") return await newsClient.open(source.open.id);
    if (source.open?.kind === "wire") return await wireClient.open(source.open.id);
  } catch {
    // Gone from where it was: look for it again.
  }
  try {
    const id = source.open && source.open.kind !== "link" ? source.open.id : null;
    const how = await aiClient.findSource(source, id);
    if (how === "searched") toast({ title: source.publisher, body: t("ai.answer.searched") });
  } catch {
    toast({ title: source.publisher, body: t("ai.answer.sourceGone"), tone: "warn" });
  }
}

function Cite({ source, number }: { source: AiSource; number: number }) {
  const label = `${source.publisher}: ${source.title}`;
  return (
    <button
      type="button"
      className="ai-cite"
      title={label}
      aria-label={t("ai.answer.openSource", { source: label })}
      onClick={() => void openSource(source)}
    >
      {number}
    </button>
  );
}

const KIND_ICON = {
  post: LuMessageCircle,
  headline: LuNewspaper,
  announcement: LuMegaphone,
} as const;

/** "3 sources", stacked marks, and the list itself on request. */
function SourceList({ sources }: { sources: readonly AiSource[] }) {
  const [open, setOpen] = useState(false);
  const when = dateFormat({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const publishers = [...new Set(sources.map((s) => s.publisher))].slice(0, 3);
  return (
    <div className="ai-sources">
      <button
        type="button"
        className="ai-sources-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ai-sources-stack" aria-hidden>
          {publishers.map((p, i) => (
            <span key={p} data-i={i}>
              {p.replace(/^@/, "").charAt(0).toUpperCase() || "·"}
            </span>
          ))}
        </span>
        {t(sources.length === 1 ? "ai.answer.source" : "ai.answer.sources", {
          count: sources.length,
        })}
        <LuChevronDown size={14} aria-hidden data-open={open || undefined} />
      </button>
      {open && (
        <ol className="ai-sources-list">
          {sources.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            const body = (
              <>
                <span className="ai-cite" aria-hidden>
                  {i + 1}
                </span>
                <span className="ai-src-main">
                  <span className="ai-src-meta">
                    <Icon size={12} aria-hidden />
                    {s.publisher}
                    {s.time > 0 && <span>· {when.format(s.time)}</span>}
                  </span>
                  <span className="ai-src-title">{s.title}</span>
                </span>
              </>
            );
            return (
              <li key={s.n}>
                <button type="button" className="ai-src" onClick={() => void openSource(s)}>
                  {body}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * The analyst's thinking: the summaries of its reasoning its provider gives,
 * and each thing it read, in order. Open while it works ("Thinking…", filling
 * in as it goes); folded once the answer is in ("Thought for 12s"), to open
 * again on a click. Text only.
 */
export function Thinking({
  steps,
  live = false,
  took,
  toolLabel,
}: {
  steps: readonly AiStep[];
  live?: boolean;
  took?: number;
  toolLabel: (name: string) => string;
}) {
  const [open, setOpen] = useState(live);
  const label = live
    ? t("ai.think.live")
    : took !== undefined
      ? t("ai.think.done", { secs: Math.max(1, Math.round(took / 1000)) })
      : t("ai.think.how");
  return (
    <div className="ai-think" data-live={live || undefined} data-open={open || undefined}>
      <button
        type="button"
        className="ai-think-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LuBrain size={14} aria-hidden />
        <span>{label}</span>
        <LuChevronDown size={14} aria-hidden data-open={open || undefined} />
      </button>
      {open && (
        <ol className="ai-think-steps">
          {steps.length === 0 && live && <li className="ai-think-wait">{t("ai.think.start")}</li>}
          {steps.map((step, i) =>
            step.kind === "thought" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are only ever appended
              <li key={i} data-kind="thought">
                {step.text.split(/\n{2,}/).map((para, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs don't move
                  <p key={j}>
                    {spansOf(para.replace(/\s*\n\s*/g, " ")).map((sp, k) =>
                      sp.kind === "bold" ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
                        <strong key={k}>{sp.text}</strong>
                      ) : sp.kind === "cite" ? null : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: spans don't move
                        <span key={k}>{sp.text}</span>
                      ),
                    )}
                  </p>
                ))}
              </li>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are only ever appended
              <li key={i} data-kind="tool">
                <span className="ai-think-tool">{toolLabel(step.name)}</span>
                {step.detail && <span className="ai-think-detail">{step.detail}</span>}
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}
