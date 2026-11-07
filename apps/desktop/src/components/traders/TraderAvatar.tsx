import type { CSSProperties } from "react";

// A trader's picture: a 5×5 mirrored pattern drawn from their key, in a hue
// of its own. Identity, not state, so the hues are the tag palette's
// (BRAND.md: never green, red or the warning orange, so a picture can't read
// as PnL or risk), at the theme's --pd-tag-l / --pd-tag-c. The same trader
// looks the same everywhere.

/** The tag palette's hues (`TAG_HUES` in components/plan/parts.tsx). */
const HUES = [205, 235, 265, 295, 325, 355, 95, 185] as const;

/** 32 bits of FNV-1a, run on `key` with `round` mixed in, for as many bits as asked. */
function bits(key: string, count: number): boolean[] {
  const out: boolean[] = [];
  for (let round = 0; out.length < count; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    for (let b = 0; b < 32 && out.length < count; b++) out.push(((h >>> b) & 1) === 1);
  }
  return out;
}

/** The trader's hue, from the tag palette. */
export function avatarHue(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return HUES[(h >>> 0) % HUES.length] ?? 235;
}

/** The cells to fill: [x, y, dim], mirrored about the middle column. */
export function avatarCells(key: string): [number, number, boolean][] {
  const b = bits(key, 32);
  const cells: [number, number, boolean][] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (!b[y * 3 + x]) continue;
      const dim = b[16 + y + x] === true;
      cells.push([x, y, dim]);
      if (x < 2) cells.push([4 - x, y, dim]);
    }
  }
  return cells;
}

export function TraderAvatar({ id, size = 28 }: { id: string; size?: number }) {
  const cells = avatarCells(id);
  return (
    <span
      className="tr-avatar"
      style={{ width: size, height: size, "--tr-h": avatarHue(id) } as CSSProperties}
      data-tone={bits(id, 33)[32] ? "soft" : undefined}
      aria-hidden
    >
      <svg viewBox="-1 -1 7 7" width={size} height={size} aria-hidden="true">
        {cells.map(([x, y, dim]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} data-dim={dim || undefined} />
        ))}
      </svg>
    </span>
  );
}
