import type { ReactNode } from "react";

/** Centered placeholder for a panel that has no data to show (yet). */
export function EmptyState({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div className="pd-empty" role={error ? "alert" : undefined} data-error={error || undefined}>
      {children}
    </div>
  );
}
