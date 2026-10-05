// Logos that ship with the app, in assets/tokens/, for markets no venue
// serves one for: mostly Bybit's stocks and ETFs, by base coin (`AAL.png`).
// `scripts/token-logos.py` builds the folder. A file named `*.badge.svg` is
// a generated badge (the ticker's letters on a disc), not a real logo.
//
// Each is its own file, loaded only when its market is first shown.

/** Every file in assets/tokens/, as a function that resolves to its URL. */
const FILES = import.meta.glob<string>("../../../../assets/tokens/*.{png,svg}", {
  query: "?url",
  import: "default",
});

/** The base coin a logo file is for: `AAL.png`, `ISRG.svg` and `BYD.badge.svg` are AAL, ISRG and BYD. */
export function logoBase(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.slice(0, file.indexOf(".")).toUpperCase();
}

/** A PNG as SVG markup that embeds it, which is what the icons are drawn from. */
export function pngAsSvg(base64: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${base64}"/></svg>`;
}

const byBase = new Map<string, { load: () => Promise<string>; svg: boolean }>();
for (const [path, load] of Object.entries(FILES)) {
  byBase.set(logoBase(path), { load, svg: path.endsWith(".svg") });
}

/** Whether a logo for `base` ships with the app. */
export const hasBundledLogo = (base: string) => byBase.has(base.toUpperCase());

/**
 * The logo that ships with the app for `base`, as SVG markup, or undefined
 * if there's none.
 */
export async function bundledLogo(base: string): Promise<string | undefined> {
  const file = byBase.get(base.toUpperCase());
  if (!file) return undefined;
  const response = await fetch(await file.load());
  if (!response.ok) throw new Error(`couldn't read the logo for ${base}`);
  if (file.svg) return response.text();
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return pngAsSvg(btoa(binary));
}
