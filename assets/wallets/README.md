# Wallet marks

Wallet logos for the Connect wallet dialog, shown beside each way to connect.
They're the wallets' trademarks, used only to identify the wallet. Bundled
rather than loaded from a URL because the webview's CSP (`img-src 'self'
data:`) doesn't allow remote images.

All come from [web3icons](https://github.com/0xa3k5/web3icons)
(`@web3icons/core` 4.0.57, `dist/svgs/wallets/background/`): each logo on its
own brand-coloured tile, so marks that are black (Ledger, OKX) still read on
a dark UI. Only the `class` attribute was removed.

To add one, check the SVG has no `<script>`, event handlers, `<image>`,
`<style>` or external `href`s, and export it from `assets/index.ts`.

## License

The SVGs are from web3icons, under the MIT License:

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
