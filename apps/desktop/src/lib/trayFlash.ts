/**
 * A line shown in the menu-bar (tray) item for a little while, in place of
 * the price and PnL: a fired alert set to show there. The newest wins.
 */
export interface TrayFlash {
  text: string;
  /** When it goes, in milliseconds since the Unix epoch. */
  until: number;
}

/** How long a line stays up. */
export const FLASH_MS = 20_000;

let flash: TrayFlash | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const publish = () => {
  for (const listener of listeners) listener();
};

/** Shows `text` in the menu bar for `FLASH_MS`, then goes back to the usual. */
export function flashTray(text: string, now = Date.now()): void {
  flash = { text, until: now + FLASH_MS };
  clearTimeout(timer);
  timer = setTimeout(() => {
    flash = undefined;
    publish();
  }, FLASH_MS);
  publish();
}

export function subscribeTrayFlash(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const currentTrayFlash = () => flash;
