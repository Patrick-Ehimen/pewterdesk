import { type MessageKey, t } from "@pewterdesk/ui";
import { panelKindOf, panelTitle } from "../../lib/panels";
import { GRID, isStatsBar, type Layout, PRESETS, type SavedLayout } from "../../lib/workspace";

// Every layout as a card, after Tealstreet's boards: a miniature of the
// layout itself (drawn from its grid, so it is always what you get, and
// works for the trader's own layouts too), its name and what it's for.

const presetLabel = (name: string) => t(`preset.${name}` as MessageKey);
const presetAbout = (name: string) => t(`preset.${name}.desc` as MessageKey);

/** A layout in miniature: each panel where it sits, named. */
export function LayoutPreview({ layout }: { layout: Layout }) {
  const rows = Math.max(GRID.rows, ...layout.map((p) => p.y + p.h));
  return (
    <div
      className="ws-preview"
      aria-hidden
      style={{
        gridTemplateColumns: `repeat(${GRID.cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
      }}
    >
      {layout.map((p) => {
        const kind = isStatsBar(p.i) ? "stats" : panelKindOf(p.i);
        return (
          <span
            key={p.i}
            className="ws-preview-panel"
            data-kind={kind}
            style={{ gridColumn: `${p.x + 1} / span ${p.w}`, gridRow: `${p.y + 1} / span ${p.h}` }}
          >
            {kind && kind !== "stats" && p.h >= 4 && (
              <span className="ws-preview-name">{panelTitle(kind)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function Card({
  layout,
  label,
  about,
  active,
  onApply,
}: {
  layout: SavedLayout;
  label: string;
  about?: string;
  active: boolean;
  onApply: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="ws-card"
        aria-current={active || undefined}
        aria-label={t("layout.use", { name: label })}
        onClick={onApply}
      >
        <LayoutPreview layout={layout.layout} />
        <span className="ws-card-name">
          {label}
          {active && <span className="ws-card-badge">{t("layout.inUse")}</span>}
        </span>
        {about && <span className="ws-card-about">{about}</span>}
      </button>
    </li>
  );
}

/** The built-in layouts and the trader's own, as cards; a click puts one on screen. */
export function LayoutGallery({
  active,
  saved,
  onApply,
}: {
  active: string;
  saved: readonly SavedLayout[];
  onApply: (layout: SavedLayout) => void;
}) {
  return (
    <div className="ws-gallery">
      <h3 className="settings-group">{t("layout.builtIn")}</h3>
      <ul className="ws-cards">
        {PRESETS.map((l) => (
          <Card
            key={l.name}
            layout={l}
            label={presetLabel(l.name)}
            about={presetAbout(l.name)}
            active={l.name === active}
            onApply={() => onApply(l)}
          />
        ))}
      </ul>
      <h3 className="settings-group">{t("layout.yours")}</h3>
      {saved.length === 0 ? (
        <p className="settings-help">{t("layout.noneSaved")}</p>
      ) : (
        <ul className="ws-cards">
          {saved.map((l) => (
            <Card
              key={l.name}
              layout={l}
              label={l.name}
              active={l.name === active}
              onApply={() => onApply(l)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
