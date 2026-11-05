import { ChartSkeleton, TableSkeleton, t } from "@pewterdesk/ui";
import type { CSSProperties, ReactNode } from "react";

// The Plan page's loading states: each view's own layout - its head, its
// strip of figures, its panels - in shimmering bars, so nothing moves when the
// data lands.

/** Widths that look organic but stay the same on every render. */
const LINE_W = [72, 58, 84, 64, 90, 52, 76, 68];
const pick = (i: number) => LINE_W[i % LINE_W.length] ?? 60;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function Bar({ w, h = 9, style }: { w: string | number; h?: number; style?: CSSProperties }) {
  return (
    <span
      className="pd-skel"
      style={{ width: typeof w === "number" ? `${w}%` : w, height: h, ...style }}
    />
  );
}

/** Lines of text: `n` bars of varied width. */
function Lines({ n, from = 0 }: { n: number; from?: number }) {
  return (
    <div className="jr-skel-lines">
      {range(n).map((i) => (
        <Bar key={i} w={pick(i + from)} />
      ))}
    </div>
  );
}

/** A panel with a title bar and its body. */
function SkelCard({
  title = 34,
  children,
  aside,
  flush,
}: {
  title?: number;
  children: ReactNode;
  aside?: boolean;
  flush?: boolean;
}) {
  return (
    <section className="jr-card">
      <header className="jr-card-head">
        <Bar w={`${title}%`} h={11} />
        {aside && <Bar w={70} h={18} style={{ marginLeft: "auto" }} />}
      </header>
      <div className="jr-card-body" data-flush={flush || undefined}>
        {children}
      </div>
    </section>
  );
}

/** The strip of figures under a view's head. */
function Kpis({ n }: { n: number }) {
  return (
    <div className="jr-kpis">
      {range(n).map((i) => (
        <div key={i} className="jr-stat">
          <Bar w={50} h={7} />
          <Bar w={pick(i) - 10} h={20} />
          <Bar w={40} h={7} />
        </div>
      ))}
    </div>
  );
}

/** Label and value pairs. */
function Pairs({ n }: { n: number }) {
  return (
    <div className="jr-skel-pairs">
      {range(n).map((i) => (
        <div key={i}>
          <Bar w={pick(i) / 2} />
          <Bar w={22} />
        </div>
      ))}
    </div>
  );
}

/** A view's head: an eyebrow, the title, a line under it, and a button. */
function Head({ buttons = 1 }: { buttons?: number }) {
  return (
    <div className="jr-head">
      <div className="jr-head-main jr-skel-head">
        <Bar w={90} h={8} />
        <Bar w={280} h={20} />
        <Bar w={220} h={9} />
      </div>
      <div className="jr-head-actions">
        {range(buttons).map((i) => (
          <Bar key={i} w={110} h={32} />
        ))}
      </div>
    </div>
  );
}

/** A chart's place in a panel. */
function Plot({ height = 220 }: { height?: number }) {
  return <span className="pd-skel jr-skel-plot" style={{ height }} />;
}

/** The wrapper every skeleton shares: one status for screen readers. */
function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="jr-skeleton" role="status" aria-busy="true" aria-label={t("plan.loading")}>
      <div className="jr-skeleton-inner" aria-hidden>
        {children}
      </div>
    </div>
  );
}

/** The rail beside a view: a few small panels. */
function Rail() {
  return (
    <div className="jr-rail">
      <SkelCard title={40}>
        <Pairs n={3} />
      </SkelCard>
      <SkelCard title={30}>
        <Lines n={3} />
      </SkelCard>
      <SkelCard title={34}>
        <Pairs n={2} />
      </SkelCard>
    </div>
  );
}

export function TodaySkeleton() {
  return (
    <Loading>
      <Head />
      <div className="jr-split">
        <SkelCard title={18} aside flush>
          {range(4).map((i) => (
            <div key={i} className="jr-skel-step">
              <span className="pd-skel jr-skel-mark" />
              <Bar w={pick(i) / 2.4} h={11} />
              <Bar w={90} style={{ marginLeft: "auto" }} />
            </div>
          ))}
        </SkelCard>
        <Rail />
      </div>
    </Loading>
  );
}

export function PlanSkeleton() {
  return (
    <Loading>
      <Head />
      <Kpis n={4} />
      <div className="jr-split">
        <div className="jr-stack">
          <SkelCard title={18} aside>
            <Pairs n={7} />
          </SkelCard>
          <SkelCard title={20}>
            <div className="jr-two">
              <Lines n={4} />
              <Lines n={3} from={3} />
            </div>
          </SkelCard>
        </div>
        <Rail />
      </div>
    </Loading>
  );
}

export function PlaybooksSkeleton() {
  return (
    <Loading>
      <Head />
      <SkelCard title={22}>
        <div className="jr-two">
          <Lines n={4} />
          <Bar w="100%" h={64} />
        </div>
      </SkelCard>
      <div className="jr-master">
        <div className="jr-pblist">
          {range(3).map((i) => (
            <div key={i} className="jr-pbitem">
              <Bar w={pick(i) - 20} h={12} />
              <Bar w={50} h={8} />
              <Bar w="100%" h={28} />
            </div>
          ))}
        </div>
        <SkelCard title={40} aside>
          <Lines n={2} />
          <Plot height={190} />
          <Pairs n={4} />
        </SkelCard>
      </div>
    </Loading>
  );
}

function DayRowSkeleton({ i }: { i: number }) {
  return (
    <div className="jr-dayrow">
      <div className="jr-date">
        <Bar w={24} h={7} />
        <Bar w={26} h={20} />
        <Bar w={24} h={7} />
      </div>
      <div className="jr-dayrow-main">
        <Bar w={pick(i) / 3} h={16} />
        <Bar w={pick(i + 2)} />
        <Bar w={pick(i + 4) / 2} h={7} />
      </div>
      <Bar w={48} h={4} />
      <span className="pd-skel jr-skel-ring" />
    </div>
  );
}

export function JournalSkeleton() {
  return (
    <Loading>
      <Head />
      <div className="jr-toolbar">
        <Bar w={220} h={30} />
      </div>
      <div className="jr-split">
        <div className="jr-stack">
          <Bar w="100%" h={56} />
          <div className="jr-pills">
            {range(6).map((i) => (
              <Bar key={i} w={82} h={28} />
            ))}
          </div>
          <div className="jr-dayrows">
            {range(5).map((i) => (
              <DayRowSkeleton key={i} i={i} />
            ))}
          </div>
        </div>
        <div className="jr-rail">
          <SkelCard title={40} aside>
            <Plot height={220} />
          </SkelCard>
        </div>
      </div>
    </Loading>
  );
}

export function DaySkeleton() {
  return (
    <Loading>
      <Head buttons={2} />
      <Kpis n={5} />
      <div className="jr-split">
        <div className="jr-phases">
          {range(3).map((i) => (
            <div key={i} className="jr-phase">
              <span className="pd-skel jr-skel-mark jr-phase-mark" />
              <SkelCard title={20 + i * 4}>
                <div className="jr-two">
                  <Lines n={3} from={i} />
                  <Lines n={2} from={i + 3} />
                </div>
                <Bar w="100%" h={44} />
              </SkelCard>
            </div>
          ))}
        </div>
        <div className="jr-rail">
          <SkelCard title={30}>
            <div className="jr-discipline">
              <span className="pd-skel jr-skel-ring jr-skel-ring-lg" />
              <Pairs n={4} />
            </div>
          </SkelCard>
          <SkelCard title={44}>
            <Lines n={3} />
          </SkelCard>
        </div>
      </div>
    </Loading>
  );
}

export function ReviewSkeleton() {
  return (
    <Loading>
      <Head />
      <Kpis n={6} />
      <Bar w="100%" h={96} />
      <div className="jr-split">
        <SkelCard title={22} aside>
          <Plot height={260} />
        </SkelCard>
        <SkelCard title={40}>
          <Pairs n={3} />
        </SkelCard>
      </div>
      <div className="jr-grid-2">
        <SkelCard title={26} flush>
          <TableSkeleton columns={6} rows={4} />
        </SkelCard>
        <SkelCard title={30}>
          <Lines n={4} />
        </SkelCard>
      </div>
    </Loading>
  );
}

export function TradeSkeleton() {
  return (
    <Loading>
      <Head buttons={2} />
      <Kpis n={6} />
      <div className="jr-split">
        <div className="jr-stack">
          <SkelCard title={22} aside>
            <TradeChartSkeleton />
            <Pairs n={2} />
          </SkelCard>
          <SkelCard title={24}>
            <div className="jr-two">
              <Bar w="100%" h={60} />
              <Bar w="100%" h={60} />
            </div>
            <Lines n={2} />
          </SkelCard>
        </div>
        <Rail />
      </div>
    </Loading>
  );
}

/** The trade chart's place while its candles load. */
export function TradeChartSkeleton() {
  return (
    <div className="jr-chart-skel">
      <ChartSkeleton />
    </div>
  );
}

/** The fills table while the venue's fills load. */
export function FillsSkeleton() {
  return <TableSkeleton columns={7} rows={2} />;
}
