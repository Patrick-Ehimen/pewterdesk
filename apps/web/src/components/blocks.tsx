// The pieces the pages are set from: the page head, a numbered section, a
// screenshot plate, a ruled table and a terminal block.
import type { ReactNode } from "react";

export function PageHead({ label, title, lede }: { label: string; title: string; lede: string }) {
  return (
    <section className="ed-wrap ed-pagehead">
      <span className="ed-label">{label}</span>
      <h1 className="ed-pagetitle">{title}</h1>
      <p className="ed-lede ed-pagelede">{lede}</p>
    </section>
  );
}

export function Section({
  id,
  label,
  children,
}: {
  id?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ed-wrap ed-section">
      <div className="ed-section-grid">
        <h2 className="ed-label ed-section-label">{label}</h2>
        <div className="ed-section-body ed-stack">{children}</div>
      </div>
    </section>
  );
}

export function Prose({ paragraphs }: { paragraphs: readonly string[] }) {
  return (
    <div className="ed-two">
      {paragraphs.map((paragraph) => (
        <p key={paragraph} className="ed-body">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

/** A screenshot on its dark plate. Every screenshot is 2880 x 1800. */
export function Plate({
  src,
  alt,
  caption,
  note,
  eager,
}: {
  src: string;
  alt: string;
  caption?: string;
  note?: string;
  eager?: boolean;
}) {
  return (
    <figure className="ed-figure">
      <div className="ed-plate" data-theme="dark">
        <img src={src} alt={alt} width={2880} height={1800} loading={eager ? "eager" : "lazy"} />
      </div>
      {caption && (
        <figcaption className="ed-strip ed-mono">
          <span>{caption}</span>
          {note && <span>{note}</span>}
        </figcaption>
      )}
    </figure>
  );
}

export function Rows({ rows }: { rows: readonly { label: string; value: string }[] }) {
  return (
    <dl className="ed-rows">
      {rows.map((row) => (
        <div key={row.label} className="ed-row">
          <dt>{row.label}</dt>
          <dd className="ed-mono">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Terminal({ commands }: { commands: readonly string[] }) {
  return (
    <pre className="ed-terminal ed-mono" data-theme="dark">
      {commands.map((command) => (
        <span key={command} className="ed-command">
          <span className="ed-prompt">$</span> {command}
        </span>
      ))}
    </pre>
  );
}
