import { useSyncExternalStore } from "react";
import type { VenueAccount } from "../../lib/account";
import { AVATAR_SIZE, avatarFor, identicon, subscribeAvatars } from "../../lib/avatars";

/** Biggest file taken in; it's shrunk to `AVATAR_SIZE` either way. */
export const AVATAR_FILE_MAX = 10 * 1024 * 1024;

/**
 * Draws a picked image file as a square picture: centre-cropped, scaled to
 * `AVATAR_SIZE` and re-encoded, so what's stored is small, and is pixels
 * this app drew rather than the file as given (an SVG's scripts or links
 * don't survive the trip through a canvas).
 */
export async function drawAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("not a picture");
  }
  if (file.size > AVATAR_FILE_MAX) throw new Error("too big");
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx || side === 0) throw new Error("not a picture");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    // WebP where the webview can write it, PNG otherwise.
    const webp = canvas.toDataURL("image/webp", 0.85);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

/** The pattern for an account without a picture, in the theme's pewter tones. */
function Identicon({ id }: { id: string }) {
  const rows = identicon(id);
  return (
    <svg viewBox="0 0 7 7" aria-hidden className="acct-identicon">
      {rows.flatMap((row, r) =>
        row.map((cell, c) =>
          cell ? (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed 5x5 grid
              key={`${r}-${c}`}
              x={c + 1}
              y={r + 1}
              width={1.02}
              height={1.02}
              data-shade={cell}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}

/**
 * An account's picture: the one the user chose, or its identicon. `live`
 * adds the connected dot at its corner.
 */
export function AccountAvatar({
  account,
  size = 32,
  live,
}: {
  account: Pick<VenueAccount, "venue" | "id">;
  size?: number;
  live?: boolean;
}) {
  const url = useSyncExternalStore(subscribeAvatars, () => avatarFor(account.venue, account.id));
  return (
    <span className="acct-avatar" style={{ width: size, height: size }}>
      {url ? (
        <img className="acct-avatar-img" src={url} alt="" />
      ) : (
        <Identicon id={`${account.venue}:${account.id}`} />
      )}
      {live && <span className="pd-live-dot acct-avatar-live" data-live aria-hidden />}
    </span>
  );
}
