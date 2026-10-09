# Venue marks

Each launch venue's own logo, shown beside its name (the market picker's venue
chips). They're the venues' trademarks, used only to identify the venue.
Bundled rather than loaded from a URL because the webview's CSP
(`img-src 'self' data:`) doesn't allow remote images.

| File | Source |
| --- | --- |
| `hyperliquid.svg` | `https://app.hyperliquid.xyz/coins/HYPE.svg`, as served |
| `bybit.svg` | web3icons (`@web3icons/core` 4.0.57, `dist/svgs/exchanges/background/bybit.svg`, MIT, license below): the mark on its own tile, so its white parts read on a light UI; only the `class` attribute removed |
| `gmx.svg`, `dydx.svg` | web3icons (`@web3icons/core` 4.0.57, `dist/svgs/tokens/background/GMX.svg` and `DYDX.svg`, MIT, license below), only the `class` attribute removed. Venues not supported yet, shown as coming soon in onboarding |
| `binance.svg`, `okx.svg` | web3icons (`@web3icons/core` 4.0.57, `dist/svgs/exchanges/background/binance.svg` and `okx.svg`, MIT, license below), only the `class` attribute removed. Venues not supported yet, shown as coming soon |
| `coinbase.svg`, `kraken.svg`, `kucoin.svg`, `bitget.svg` | web3icons (`@web3icons/core` 4.0.57, the SVG in `dist/svgs/exchanges/background/coinbase.svg.js`, `kraken.svg.js`, `kucoin.svg.js` and `bitget.svg.js`, MIT, license below), only the `class` attribute removed. Venues not supported yet, shown as coming soon |
| `backpack.svg` | web3icons (`@web3icons/core` 4.0.57, the SVG in `dist/svgs/wallets/background/backpack.svg.js`, MIT, license below), only the `class` attribute removed: the set has Backpack's mark under wallets, and the exchange uses the same one. A venue not supported yet, shown as coming soon |
| `aster.svg` | The mark from `https://static.asterdexfx.com/cloud-futures/static/images/aster/logo.svg` (Aster's wordmark), cropped to the symbol |

To add one, check the SVG has no `<script>`, event handlers, `<image>` or
external `href`s, and export it from `assets/index.ts` under its `VenueId`.

## License

`bybit.svg`, `binance.svg`, `okx.svg`, `coinbase.svg`, `kraken.svg`, `kucoin.svg`, `bitget.svg`, `backpack.svg`, `gmx.svg` and `dydx.svg` are from [web3icons](https://github.com/0xa3k5/web3icons), under
the MIT License:

```
MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
