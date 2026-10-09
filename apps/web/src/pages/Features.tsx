import depthShot from "../assets/depth.png";
import liquidationsShot from "../assets/liquidations.png";
import multiChartShot from "../assets/multi-chart.png";
import tradeShot from "../assets/trade.png";
import { PageHead, Plate, Prose, Rows, Section } from "../components/blocks";
import { depth, edges, head, maps, multiChart, palette, rules, trade } from "../content/features";

export function Features() {
  return (
    <>
      <PageHead {...head} />

      <Section id="trade" label={trade.label}>
        <p className="ed-headline">{trade.title}</p>
        <Prose paragraphs={trade.body} />
        <Plate src={tradeShot} alt={trade.alt} caption={trade.caption} eager />
        <Rows rows={trade.rows} />
      </Section>

      <Section id="depth" label={depth.label}>
        <p className="ed-headline">{depth.title}</p>
        <Prose paragraphs={depth.body} />
        <Plate src={depthShot} alt={depth.alt} caption={depth.caption} />
      </Section>

      <Section id="multiChart" label={multiChart.label}>
        <p className="ed-headline">{multiChart.title}</p>
        <Prose paragraphs={multiChart.body} />
        <Plate src={multiChartShot} alt={multiChart.alt} caption={multiChart.caption} />
        <Rows rows={multiChart.rows} />
      </Section>

      <Section id="liquidations" label={maps.label}>
        <p className="ed-headline">{maps.title}</p>
        <Prose paragraphs={maps.body} />
        <Plate src={liquidationsShot} alt={maps.alt} caption={maps.caption} />
        <Rows rows={maps.rows} />
      </Section>

      <Section id="palette" label={palette.label}>
        <p className="ed-headline">{palette.title}</p>
        <Prose paragraphs={palette.body} />
        <figure className="ed-figure">
          <div className="ed-terminal ed-mono ed-palette" data-theme="dark">
            <span className="ed-palette-key">{palette.shortcut}</span>
            {palette.commands.map((command) => (
              <span key={command.text} className="ed-palette-row">
                <span>
                  <span className="ed-prompt">›</span> {command.text}
                </span>
                <span className="ed-prompt">{command.note}</span>
              </span>
            ))}
          </div>
        </figure>
      </Section>

      <Section id="rules" label={rules.label}>
        <p className="ed-headline">{rules.title}</p>
        <Prose paragraphs={rules.body} />
        <div>
          <ol className="ed-biglist">
            {rules.list.map((rule) => (
              <li key={rule} className="ed-row">
                {rule}
              </li>
            ))}
          </ol>
          <p className="ed-mono ed-note ed-listnote">{rules.note}</p>
        </div>
      </Section>

      <Section id="more" label={edges.label}>
        <p className="ed-headline">{edges.title}</p>
        <ul className="ed-callouts ed-callouts-grid">
          {edges.items.map((item) => (
            <li key={item.title}>
              <span className="ed-callout-title">{item.title}</span>
              <span className="ed-callout-body">{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
