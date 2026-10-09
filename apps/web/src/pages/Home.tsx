// The home page, after the editorial mockup in the local `design/landing/`.
import depthShot from "../assets/depth.png";
import liquidationsShot from "../assets/liquidations.png";
import multiChartShot from "../assets/multi-chart.png";
import tradeShot from "../assets/trade.png";
import { Plate, Prose, Section, Terminal } from "../components/blocks";
import { VenueIcon } from "../components/VenueIcon";
import { callouts, figure, hero, inside, install, status, venues, why } from "../content/home";
import { ISSUES_URL, paths, RELEASES_URL } from "../site";

const insideShots = {
  depth: depthShot,
  multiChart: multiChartShot,
  liquidations: liquidationsShot,
} as const;

export function Home() {
  return (
    <>
      <section className="ed-wrap ed-hero">
        <h1 className="ed-wordmark">pewterdesk</h1>
        <div className="ed-hero-grid">
          <div className="ed-col">
            <span className="ed-label">01 / What</span>
            <p className="ed-lede">{hero.what}</p>
          </div>
          <div className="ed-col">
            <span className="ed-label">02 / How</span>
            <p className="ed-body">{hero.how}</p>
          </div>
          <div className="ed-col ed-col-start">
            <span className="ed-label">03 / Get it</span>
            <a href={RELEASES_URL} className="ed-btn ed-btn-ink">
              {hero.download}
            </a>
            <a href={paths.download} className="ed-underlined">
              {hero.source}
            </a>
            <span className="ed-mono ed-note">{hero.note}</span>
          </div>
        </div>
      </section>

      <section className="ed-wrap ed-figure-section">
        <Plate src={tradeShot} alt={figure.alt} caption={figure.caption} note={figure.note} eager />
        <ol className="ed-callouts">
          {callouts.map((callout, index) => (
            <li key={callout.title}>
              <span className="ed-label">{String(index + 1).padStart(2, "0")}</span>
              <span className="ed-callout-title">{callout.title}</span>
              <span className="ed-callout-body">{callout.body}</span>
            </li>
          ))}
        </ol>
      </section>

      <Section id="why" label="§ 01 — Why">
        <p className="ed-headline">{why.headline}</p>
        <Prose paragraphs={why.body} />
      </Section>

      <Section id="inside" label="§ 02 — Inside">
        <p className="ed-headline">{inside.headline}</p>
        <div className="ed-plates">
          {inside.plates.map((plate) => (
            <a key={plate.id} href={`${paths.features}#${plate.id}`} className="ed-plate-card">
              <Plate src={insideShots[plate.id]} alt={plate.alt} />
              <span className="ed-callout-title">{plate.title}</span>
              <span className="ed-callout-body">{plate.body}</span>
            </a>
          ))}
        </div>
        <a href={paths.features} className="ed-underlined ed-more">
          {inside.more} →
        </a>
      </Section>

      <Section id="venues" label="§ 03 — Venues">
        <div>
          <h3 className="ed-label ed-sublabel">
            {venues.now.label} · {venues.now.items.length}
          </h3>
          <ul className="ed-venues">
            {venues.now.items.map((venue) => (
              <li key={venue.id} className="ed-row ed-venue">
                <span className="ed-venue-name">
                  <VenueIcon id={venue.id} />
                  {venue.name}
                </span>
                <span className="ed-venue-kind">{venue.kind}</span>
                <span className="ed-venue-chain ed-mono">{venue.chain}</span>
                <span className={`ed-venue-status ed-mono${venue.live ? " is-live" : ""}`}>
                  {venue.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="ed-label ed-sublabel">
            {venues.coming.label} · {venues.coming.items.length}
          </h3>
          <ul className="ed-coming">
            {venues.coming.items.map((venue) => (
              <li key={venue.id}>
                <VenueIcon id={venue.id} small />
                <span className="ed-callout-title">{venue.name}</span>
                <span className="ed-callout-body">{venue.kind}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="status" label="§ 04 — Status">
        <p className="ed-headline">{status.headline}</p>
        <Prose paragraphs={status.body} />
        <div className="ed-ledger">
          {[status.works, status.notYet].map((side) => (
            <div key={side.title} className={side === status.notYet ? "is-muted" : undefined}>
              <h3 className="ed-label">{side.title}</h3>
              <ul className="ed-biglist">
                {side.items.map((item) => (
                  <li key={item} className="ed-row">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <a href={ISSUES_URL} className="ed-underlined ed-more">
          {status.report} →
        </a>
      </Section>

      <Section id="install" label="§ 05 — Install">
        <div className="ed-install">
          <div className="ed-col ed-col-start">
            <p className="ed-lede">{install.lede}</p>
            <a href={RELEASES_URL} className="ed-btn ed-btn-brass">
              {install.download}
            </a>
            <span className="ed-mono ed-note">{install.note}</span>
          </div>
          <Terminal commands={install.commands} />
        </div>
      </Section>
    </>
  );
}
