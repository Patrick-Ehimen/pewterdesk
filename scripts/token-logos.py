#!/usr/bin/env python3
"""Builds assets/tokens/: a logo for each Bybit market that no venue serves one for.

The app looks for a market's logo at the venues first (Bybit's own list,
Hyperliquid, Aster), then here, then at CoinGecko (for a coin listed since
this was last run). This script fills assets/tokens/ for the markets the
venues don't cover:

- stocks, ETFs, commodities and forex: the real logo, by the market's
  underlying ticker, from financialmodelingprep.com's public images;
- crypto coins: CoinGecko's logo (the same one the app would look up, saved
  so it shows at once), else Binance's public asset list;
- anything still without one: a generated badge, the ticker's first letters
  on a colored disc. Not a real logo, and named `*.badge.svg` to say so.

Logos are saved as 64px PNGs. One drawn in a single dark or light color on a
transparent background would vanish against the app's own background, so
those are saved as an SVG that puts the PNG on a contrasting tile.

Run from the repo root, on macOS (it resizes with `sips`):

    python3 scripts/token-logos.py

It needs the network, takes a few minutes (it probes each venue's logo host
and spaces its CoinGecko lookups), and rewrites assets/tokens/ from scratch.
The logos are their owners' trademarks, shown to identify the markets.
"""

import base64
import colorsys
import concurrent.futures
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "tokens"
SIZE = 64
AGENT = {"User-Agent": "Mozilla/5.0 (pewterdesk token-logos)"}
MULTIPLIER = re.compile(r"^(1000000|100000|10000|1000|100)(.+)$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# Coins Bybit names differently from everyone else, by the ticker their logo
# is listed under elsewhere.
ALIASES = {
    "SHIB1000": "SHIB",
    "RAYDIUM": "RAY",
    "PUMPFUN": "PUMP",
    "SOLAYER": "LAYER",
    "1000NEIROCTO": "NEIRO",
    # A perpetual on the ETH/BTC ratio: ETH's logo stands for it.
    "ETHBTC": "ETH",
}
# Coins whose Bybit name isn't the ticker CoinGecko lists them under, by
# their CoinGecko id.
COINGECKO_IDS = {
    "PLAYSOUT": "playsout",
    "SPORTFUN": "football-fun",
    "SKYAI1": "skyai",
    "NESA": "nesa",
    "NIULAI": "niu-lai",
}


def get(url, data=None, tries=1):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(
                url, data=data, headers={**AGENT, "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt + 1 < tries:
                time.sleep(25)
                continue
            return None, ""
        except Exception:
            time.sleep(3)
    return None, ""


def get_json(url, data=None, tries=1):
    body, _ = get(url, data, tries)
    return json.loads(body) if body else None


def bybit_markets():
    """Each live perpetual's base coin, with what Bybit says about it."""
    coins, cursor = {}, ""
    while True:
        page = get_json(
            "https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000"
            + (f"&cursor={cursor}" if cursor else "")
        )["result"]
        for i in page["list"]:
            if i["status"] == "Trading" and i["contractType"] == "LinearPerpetual":
                coins.setdefault(i["baseCoin"], i)
        cursor = page.get("nextPageCursor", "")
        if not cursor:
            return coins


def plain(base):
    """The coin behind a multiplied one: 1000000MOG is MOG."""
    match = MULTIPLIER.match(base)
    return match.group(2) if match else None


# The largest logo the app takes from Aster (its adapter's MAX_ICON_BYTES).
ASTER_MAX_BYTES = 64 * 1024


def aster_serves(url):
    """Whether Aster's logo at `url` is one the app accepts: a few of its files
    are over the adapter's size cap, and are turned down."""
    body, _ = get(url)
    return bool(body) and len(body) <= ASTER_MAX_BYTES


def venue_has(base, aster):
    """Whether Aster's logo list or Hyperliquid's logo host has `base`, as the app asks them."""
    coin = plain(base)
    url = aster.get(base) or (aster.get(coin) if coin else None)
    if url and aster_serves(url):
        return True
    names = [base] + ([coin] if coin else [])
    if coin and MULTIPLIER.match(base).group(1) == "1000":
        names.append("k" + coin)
    for name in names:
        if name.startswith("k") and name[1:2].isupper():
            name = name[1:]
        if not name.isalnum():
            continue
        _, kind = get(f"https://app.hyperliquid.xyz/coins/{name}.svg")
        if kind.startswith("image/svg+xml"):
            return True
    return False


def coingecko_logo(base):
    """CoinGecko's logo for the coin, as image bytes: found by its ticker as the
    app would (the best-ranked coin with exactly that symbol), or by its id
    for a coin in COINGECKO_IDS. None if it has none; False if it couldn't be asked."""
    ticker = base
    for prefix in ("1000000", "100000", "10000", "1000", "k"):
        rest = ticker[len(prefix) :]
        if ticker.startswith(prefix) and len(rest) >= 2 and re.fullmatch(r"[A-Z0-9]+", rest):
            ticker = rest
            break
    wanted = COINGECKO_IDS.get(base)
    if wanted:
        # Straight from the coin's own page: search doesn't find every id.
        coin = get_json(
            f"https://api.coingecko.com/api/v3/coins/{wanted}?localization=false&tickers=false"
            "&market_data=false&community_data=false&developer_data=false",
            tries=6,
        )
        time.sleep(2.2)
        if coin is None:
            return False
        image = (coin.get("image") or {}).get("large", "")
    else:
        found = get_json(f"https://api.coingecko.com/api/v3/search?query={ticker}", tries=6)
        time.sleep(2.2)
        if found is None:
            return False
        match = [c for c in found.get("coins", []) if c.get("symbol", "").upper() == ticker.upper()]
        match.sort(key=lambda c: c.get("market_cap_rank") or 10**9)
        image = match[0].get("large", "") if match else ""
    if not image.startswith("https://coin-images.coingecko.com/coins/images/"):
        return None
    body, _ = get(image.split("?")[0].replace("/large/", "/small/", 1))
    return body


def decode_png(data):
    """(width, height, rows of RGBA tuples) for an 8-bit, non-interlaced PNG; else None."""
    if data[:8] != PNG_MAGIC:
        return None
    pos, chunks, palette, alphas, header = 8, [], None, b"", None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            alphas = body
        elif kind == b"IDAT":
            chunks.append(body)
    width, height, depth, color, _, _, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if depth != 8 or interlace or not channels:
        return None
    raw, stride = zlib.decompress(b"".join(chunks)), width * channels
    rows, previous, at = [], bytearray(stride), 0
    for _ in range(height):
        kind, line = raw[at], bytearray(raw[at + 1 : at + 1 + stride])
        at += 1 + stride
        for x in range(stride):
            left = line[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                line[x] = (line[x] + left) & 255
            elif kind == 2:
                line[x] = (line[x] + up) & 255
            elif kind == 3:
                line[x] = (line[x] + (left + up) // 2) & 255
            elif kind == 4:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 255
        previous = line
        row = []
        for x in range(width):
            px = line[x * channels : (x + 1) * channels]
            if color == 6:
                row.append(tuple(px))
            elif color == 2:
                row.append((px[0], px[1], px[2], 255))
            elif color == 0:
                row.append((px[0], px[0], px[0], 255))
            elif color == 4:
                row.append((px[0], px[0], px[0], px[1]))
            else:
                i = px[0]
                alpha = alphas[i] if i < len(alphas) else 255
                row.append((*palette[i * 3 : i * 3 + 3], alpha))
        rows.append(row)
    return width, height, rows


def tile_for(png):
    """The tile a logo needs behind it to be seen on any background: "light" for
    one drawn dark on transparent, "dark" for one drawn light, None otherwise."""
    decoded = decode_png(png)
    if not decoded:
        return None
    width, height, rows = decoded
    opaque = [px for row in rows for px in row if px[3] > 128]
    if not opaque or len(opaque) > 0.75 * width * height:
        return None  # nothing to see, or it fills its square: it brings its own background
    light = sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b, _ in opaque) / len(opaque)
    if light < 70:
        return "light"
    if light > 215:
        return "dark"
    return None


def resized(image, work):
    """`image` as a PNG no larger than SIZE on a side, via sips; None if it isn't an image."""
    source, target = work / "in", work / "out.png"
    source.write_bytes(image)
    done = subprocess.run(
        ["sips", "-s", "format", "png", "-Z", str(SIZE), str(source), "--out", str(target)],
        capture_output=True,
    )
    if done.returncode != 0 or not target.exists():
        return None
    png = target.read_bytes()
    return png if png[:8] == PNG_MAGIC else None


def on_tile(png, tile):
    fill = "#f3f5f6" if tile == "light" else "#1c2327"
    data = base64.b64encode(png).decode()
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="14" fill="{fill}"/>'
        f'<image x="9" y="9" width="46" height="46" href="data:image/png;base64,{data}"/></svg>\n'
    )


def badge(label):
    """A disc in a color picked from the label, with its first letters on it."""
    letters = re.sub(r"[^A-Z0-9]", "", label.upper())[:4] or "?"
    hue = int(hashlib.sha256(label.encode()).hexdigest()[:4], 16) / 0xFFFF
    r, g, b = (round(c * 255) for c in colorsys.hls_to_rgb(hue, 0.34, 0.38))
    size = {1: 30, 2: 26, 3: 20}.get(len(letters), 16)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<circle cx="32" cy="32" r="32" fill="#{r:02x}{g:02x}{b:02x}"/>'
        f'<text x="32" y="32" dy="0.36em" text-anchor="middle" fill="#f3f5f6" '
        f'font-family="-apple-system, \'Segoe UI\', Helvetica, Arial, sans-serif" '
        f'font-size="{size}" font-weight="700">{letters}</text></svg>\n'
    )


def save_logo(base, image, work):
    png = resized(image, work)
    if not png:
        return False
    tile = tile_for(png)
    if tile:
        (OUT / f"{base}.svg").write_text(on_tile(png, tile))
    else:
        (OUT / f"{base}.png").write_bytes(png)
    return True


def main():
    if not shutil.which("sips"):
        sys.exit("needs macOS's sips to resize images")
    print("reading Bybit's markets...")
    coins = bybit_markets()
    aster_list = get_json(
        "https://www.asterdex.com/bapi/futures/v1/public/future/asset/ae/all-asset-logo", b"{}"
    )
    aster = {
        row["assetCode"]: row["logoUrl"]
        for row in (aster_list or {}).get("data") or []
        if (row.get("logoUrl") or "").startswith("https://static.astherus.finance/")
    }
    print(f"checking which of {len(coins)} coins the venues have a logo for...")
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        covered = dict(zip(coins, pool.map(lambda b: venue_has(b, aster), coins)))
    missing = [b for b in coins if not covered[b]]
    crypto = [b for b in missing if coins[b].get("symbolType", "") in ("", "innovation")]
    others = [b for b in missing if b not in crypto]

    print(f"asking CoinGecko about {len(crypto)} crypto coins (spaced out; a few minutes)...")
    from_coingecko = {b: coingecko_logo(b) for b in crypto}

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    binance = get_json("https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset")
    binance_logo = {
        row["assetCode"].upper(): row["logoUrl"]
        for row in (binance or {}).get("data") or []
        if (row.get("logoUrl") or "").startswith("https://bin.bnbstatic.com/")
    }
    real, made = [], []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for base in sorted(others):
            ticker = (coins[base].get("underlyingTicker") or base).upper()
            image, _ = get(f"https://financialmodelingprep.com/image-stock/{ticker}.png")
            if image and save_logo(base, image, work):
                real.append(base)
            else:
                # By the market's name, not its ticker: Hong Kong's are numbers.
                (OUT / f"{base}.badge.svg").write_text(badge(base))
                made.append(base)
        for base in sorted(crypto):
            image = from_coingecko[base]
            if image is False:
                # Couldn't ask: left for the app to look up, not given a badge.
                continue
            if not image:
                url = (
                    binance_logo.get(ALIASES.get(base, base).upper())
                    or binance_logo.get((plain(base) or "").upper())
                )
                image = get(url)[0] if url else None
            if image and save_logo(base, image, work):
                real.append(base)
            else:
                (OUT / f"{base}.badge.svg").write_text(badge(plain(base) or base))
                made.append(base)
    print(f"saved {len(real)} real logos and {len(made)} generated badges to {OUT}")
    print("generated badges (no real logo found):", ", ".join(made))


if __name__ == "__main__":
    main()
