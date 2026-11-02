import {
  type DrawingTemplateCatalog,
  DrawingTemplateConflictError,
  DrawingTemplateRepository,
  type DrawingTemplateStore,
} from "openalgo-charts/workspace";

// Saved looks for drawings, and each tool's default: kept on this machine,
// shared by every chart. Only styles: no prices, words or anything of an account.

const KEY = "pd.drawingTemplates:";

function read(namespace: string): unknown | null {
  try {
    return JSON.parse(localStorage.getItem(KEY + namespace) ?? "null");
  } catch {
    return null;
  }
}

let shared: DrawingTemplateStore | undefined;

/** The one store every chart shares. */
export function drawingTemplateStore(): DrawingTemplateStore {
  shared ??= new DrawingTemplateRepository(
    {
      read: async (namespace) => read(namespace),
      write: async (namespace, catalog: DrawingTemplateCatalog, expected) => {
        const now = read(namespace) as { revision?: number } | null;
        if ((now?.revision ?? 0) !== expected) throw new DrawingTemplateConflictError();
        localStorage.setItem(KEY + namespace, JSON.stringify(catalog));
      },
    },
    "local",
  );
  return shared;
}
