# Venue marks

Each launch venue's own logo, shown beside its name (the market picker's venue
chips). They're the venues' trademarks, used only to identify the venue.
Bundled rather than loaded from a URL because the webview's CSP
(`img-src 'self' data:`) doesn't allow remote images.

| File | Source |
| --- | --- |
| `hyperliquid.svg` | `https://app.hyperliquid.xyz/coins/HYPE.svg`, as served |
| `aster.svg` | The mark from `https://static.asterdexfx.com/cloud-futures/static/images/aster/logo.svg` (Aster's wordmark), cropped to the symbol |

To add one, check the SVG has no `<script>`, event handlers, `<image>` or
external `href`s, and export it from `assets/index.ts` under its `VenueId`.
