// The frame every page sits in: masthead, the closing call to download, and
// the colophon.
import type { ReactNode } from "react";
import {
  closing,
  footer,
  masthead,
  nav,
  notice,
  type PageId,
  paths,
  RELEASES_URL,
  REPO_URL,
} from "../site";
import { Mark } from "./Mark";

export function Layout({ page, children }: { page: PageId; children: ReactNode }) {
  return (
    <>
      <aside className="ed-notice" data-theme="dark" aria-label={notice.label}>
        <p className="ed-wrap ed-mono">
          <strong>{notice.label}</strong>
          <span>{notice.text}</span>
          <a href={notice.href}>{notice.link} →</a>
        </p>
      </aside>
      <header className="ed-wrap">
        <nav className="ed-nav">
          <a href={paths.home} className="ed-brand" aria-label="Pewterdesk home">
            <Mark />
            <span>pewterdesk</span>
          </a>
          <div className="ed-links">
            {nav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={link.page === page ? "page" : undefined}
              >
                {link.label}
              </a>
            ))}
          </div>
          <a href={paths.download} className="ed-btn ed-btn-brass ed-btn-small">
            Download
          </a>
        </nav>
        <div className="ed-strip ed-mono">
          {masthead.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </header>

      <main>
        {children}

        <section className="ed-wrap ed-closing">
          <p className="ed-closing-line">
            {closing.lines[0]}
            <br />
            {closing.lines[1]}
          </p>
          <div className="ed-actions">
            <a href={RELEASES_URL} className="ed-btn ed-btn-ink">
              {closing.download}
            </a>
            <a href={REPO_URL} className="ed-btn ed-btn-outline">
              {closing.source}
            </a>
          </div>
        </section>
      </main>

      <footer className="ed-wrap ed-colophon">
        <div className="ed-footer">
          <a href={paths.home} className="ed-brand" aria-label="Pewterdesk home">
            <Mark />
            <span>pewterdesk</span>
          </a>
          {footer.groups.map((group) => (
            <div key={group.title} className="ed-footer-group">
              <span className="ed-label">{group.title}</span>
              {group.links.map((link) => (
                <a key={link.href} href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="ed-strip ed-mono">
          <span>{footer.note}</span>
        </div>
      </footer>
    </>
  );
}
