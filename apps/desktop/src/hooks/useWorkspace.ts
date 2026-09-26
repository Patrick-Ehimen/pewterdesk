import { useEffect, useState } from "react";
import { initialWorkspace, sanitizeWorkspace, type WorkspaceState } from "../lib/workspace";

const STORAGE_KEY = "pd.workspace.v1";

// Layout is a per-machine convenience, so browser storage is fine; it holds
// nothing but panel positions. Everything read back is sanitised.
function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeWorkspace(JSON.parse(raw)) : initialWorkspace();
  } catch {
    return initialWorkspace();
  }
}

export function useWorkspace() {
  const [state, setState] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable; the layout just won't survive a restart.
    }
  }, [state]);
  return [state, setState] as const;
}
