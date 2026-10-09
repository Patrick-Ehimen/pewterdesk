import { PageHead, Section, Terminal } from "../components/blocks";
import { firstRun, head, installers, source } from "../content/download";
import { RELEASES_URL } from "../site";

export function Download() {
  return (
    <>
      <PageHead {...head} />

      <Section id="installers" label={installers.label}>
        <ul className="ed-venues">
          {installers.rows.map((row) => (
            <li key={`${row.platform} ${row.detail}`} className="ed-row ed-venue">
              <span className="ed-venue-name">
                {row.platform} <span className="ed-venue-detail">{row.detail}</span>
              </span>
              <span className="ed-venue-chain ed-mono">{row.files}</span>
              <span className="ed-venue-chain ed-mono">{row.needs}</span>
            </li>
          ))}
        </ul>
        <div className="ed-col ed-col-start">
          <a href={RELEASES_URL} className="ed-btn ed-btn-brass">
            {installers.button}
          </a>
          <span className="ed-mono ed-note">{installers.note}</span>
        </div>
      </Section>

      <Section id="first-run" label={firstRun.label}>
        <p className="ed-headline">{firstRun.title}</p>
        <ol className="ed-steps">
          {firstRun.steps.map((step) => (
            <li key={step.title} className="ed-row">
              <span className="ed-step-title">{step.title}</span>
              <span className="ed-body">{step.body}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="source" label={source.label}>
        <p className="ed-headline">{source.title}</p>
        <div className="ed-install">
          <div className="ed-col">
            <p className="ed-body">{source.body}</p>
            <p className="ed-mono ed-note">
              <span className="ed-inline-code">{source.bundle}</span> {source.bundleNote}
            </p>
          </div>
          <Terminal commands={source.commands} />
        </div>
      </Section>
    </>
  );
}
