import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Tooltip } from "./Tooltip";

export interface Column {
  label: string;
  /** Explains the column; shown on hover or focus. */
  hint: ReactNode;
}

/** A book-style three-column header where every column explains itself. */
export function ColumnHeader({ columns }: { columns: Column[] }) {
  return (
    <div className="pd-book-head">
      {columns.map((c) => (
        <span key={c.label}>
          <Tooltip content={c.hint}>{c.label}</Tooltip>
        </span>
      ))}
    </div>
  );
}

/** Tooltip body: a title line and a short explanation under it. */
export function Hint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <strong className="pd-tip-title">{title}</strong>
      <span className="pd-tip-body">{children}</span>
    </>
  );
}

/** " In USDC." — appended to a hint when the column's asset is known. */
export function unitHint(asset?: string): string {
  return asset ? ` ${t("hint.unit", { asset })}` : "";
}
