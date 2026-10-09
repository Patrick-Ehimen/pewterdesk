import { PageHead, Prose, Rows, Section } from "../components/blocks";
import { backend, delegated, head, keys, limits, live, surface } from "../content/security";
import { ADR_URL, REPO_URL } from "../site";

export function Security() {
  return (
    <>
      <PageHead {...head} />

      <Section id="backend" label={backend.label}>
        <p className="ed-headline">{backend.title}</p>
        <Prose paragraphs={backend.body} />
        <figure className="ed-figure">
          <div className="ed-route">
            <span>{backend.route[0]}</span>
            <span className="ed-route-line" aria-hidden="true" />
            <span>{backend.route[1]}</span>
          </div>
          <figcaption className="ed-strip ed-mono">
            <span>{backend.routeNote}</span>
          </figcaption>
        </figure>
      </Section>

      <Section id="keys" label={keys.label}>
        <p className="ed-headline">{keys.title}</p>
        <Rows rows={keys.rows} />
      </Section>

      <Section id="delegated" label={delegated.label}>
        <p className="ed-headline">{delegated.title}</p>
        <p className="ed-body ed-measure">{delegated.body}</p>
        <ul className="ed-venues">
          {delegated.venues.map((venue) => (
            <li key={venue.name} className="ed-row ed-keyrow">
              <span className="ed-keyrow-name">{venue.name}</span>
              <span className="ed-keyrow-kind ed-mono">{venue.key}</span>
              <span className="ed-body ed-keyrow-check">{venue.check}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="surface" label={surface.label}>
        <p className="ed-headline">{surface.title}</p>
        <p className="ed-body ed-measure">{surface.body}</p>
        <div>
          <div className="ed-ledger">
            {[surface.can, surface.cannot].map((side) => (
              <div key={side.title} className={side === surface.cannot ? "is-struck" : undefined}>
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
          <p className="ed-mono ed-note ed-listnote">{surface.note}</p>
        </div>
      </Section>

      <Section id="live" label={live.label}>
        <p className="ed-headline">{live.title}</p>
        <Prose paragraphs={live.body} />
      </Section>

      <Section id="limits" label={limits.label}>
        <p className="ed-headline">{limits.title}</p>
        <ol className="ed-steps">
          {limits.items.map((item) => (
            <li key={item} className="ed-row">
              <span className="ed-body">{item}</span>
            </li>
          ))}
        </ol>
        <div className="ed-actions ed-actions-flush">
          <a href={ADR_URL} className="ed-underlined">
            {limits.source} →
          </a>
          <a href={REPO_URL} className="ed-underlined">
            {limits.code} →
          </a>
        </div>
      </Section>
    </>
  );
}
