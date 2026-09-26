import type { ReactNode } from "react";

export interface Tab<Id extends string> {
  id: Id;
  label: ReactNode;
}

interface TabsProps<Id extends string> {
  tabs: readonly Tab<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** Rendered at the right end of the tab strip. */
  aside?: ReactNode;
}

export function Tabs<Id extends string>({ tabs, active, onChange, aside }: TabsProps<Id>) {
  return (
    <div className="pd-tabs">
      <div className="pd-tabs-list" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            className="pd-tab"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {aside && <div className="pd-tabs-aside">{aside}</div>}
    </div>
  );
}
