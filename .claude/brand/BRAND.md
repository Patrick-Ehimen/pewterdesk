# Pewterdesk brand

Pewter and brass on near-black. Pewter carries the interface, brass marks the one
thing that matters, and green and red belong to the market.

- Visual reference (public): https://claude.ai/artifact/TkzifKdfEBcZF9t4ASpLpt
- Tokens: `.claude/brand/pewterdesk-tokens.css`
- Logos, icons, favicons: `assets/` (`assets/logo`, `assets/icon`, `assets/favicon`)

## Rules for code

- Use only the `--pd-*` CSS variables. Never hardcode a hex value in components.
- Brass (`--pd-brass`) is the only brand accent. Never use it for buy, sell, profit or loss.
- Green and red are market colors only: `--pd-buy` / `--pd-sell` for bids, asks, longs,
  shorts, PnL and fills. Depth bars and row flashes use `--pd-buy-tint` / `--pd-sell-tint`.
- Keep brass to about 5% of a screen: one key action, focus rings (`--pd-focus`), the live dot.
- `--pd-pewter` for secondary numbers (sizes, totals, timestamps). `--pd-pewter-dim` is for
  hints and disabled states only, never for data a trader needs to read.
- In light mode, brass used as text is `--pd-brass-text`, not `--pd-brass`.
- Don't add a second accent hue (no teal, cyan or purple).

## Core palette

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| bg | #111110 | #F4F3EF | App background, icon tile |
| surface | #1A1A18 | #FFFFFF | Panels: order book, order entry, positions |
| surface-raised | #222220 | #FAFAF7 | Menus, popovers, hovered rows |
| border | #2A2A27 | #E3E1DA | Dividers, table lines |
| border-strong | #3A3A36 | #CFCCC3 | Input outlines, active panel edge |
| text | #ECEBE6 | #1A1A18 | Primary text, prices |
| pewter | #A3A7A6 | #6B6F6E | Secondary text, labels, logo bars |
| pewter-dim | #6E7271 | #8A8E8D | Hints, placeholders, disabled |
| brass | #C9A45C | #B08A3E | Brand accent fill |
| brass-text | #C9A45C | #8A6A2A | Brass used as text |
| brass-hover | #D6B574 | #9C7932 | Hover/pressed brass |

## Trading colors

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| buy | #4CB782 | #177A4F | Bids, longs, positive PnL, buy button |
| on-buy | #0B1F14 | #FFFFFF | Text on buy button |
| sell | #E0584F | #C23A30 | Asks, shorts, negative PnL, sell button |
| on-sell | #2A0B09 | #FFFFFF | Text on sell button |
| warning | #E8894A | #A04F12 | Liquidation risk, high leverage, stale feed |
| info | #8FB3D9 | #2F6FA8 | Links, neutral notices, funding info |

Colorblind mode (`data-market="colorblind"`): buy #4C9BE8, sell #E8894A, warning #D96BC7.

## Themes

Six themes in the app's picker, set with `data-theme` on `<html>`. Every text
token passes WCAG AA (4.5:1) on bg, surface and surface-raised, with the
exceptions noted under Contrast.

| `data-theme` | Name | Character | bg | Accent |
| --- | --- | --- | --- | --- |
| `dark` (default) | Pewter | Pewter and brass on near-black | #111110 | brass #C9A45C |
| `graphite` | Graphite | Cooler, a step lighter; for long sessions | #17181A | brass #C9A45C |
| `synthwave` | Synthwave '84 | Neon pink on retro purple | #241B2F | pink #FF7EDB |
| `monokai` | Monokai Pro | Filter Machine: yellow on cool teal-grey | #1D2528 | yellow #FFED72 |
| `palenight` | Palenight | Soft purple on slate blue | #202331 | purple #C792EA |
| `parchment` | Parchment | Warm, paper-toned light | #F2ECDF | brass #A9803A |

`light` (Porcelain, the light column of the core palette) stays defined in the
tokens but isn't offered in the picker.

**Exception to "brass is the sole accent":** the three editor-inspired themes
(Synthwave '84, Monokai Pro, Palenight) replace brass with their own signature
color through the same `--pd-brass*` tokens. Each still has exactly one accent,
used only where brass would be, and green/red remain market-only in all six.
Their market reds are lightened slightly from the editor originals where the
original fails contrast. Don't carry these accents into the pewter themes.

Full values are in the tokens file. A new theme defines every `--pd-*` color
token; check it with a contrast script before adding it here.

## Logo

Depth-ladder mark: five pill bars forming a diamond; only the middle bar (mid price) is brass.

| Variant | Bars | Mid bar | "pewter" | "desk" |
| --- | --- | --- | --- | --- |
| dark-bg | #A3A7A6 | #C9A45C | #ECEBE6 | #A3A7A6 |
| light-bg | #6B6F6E | #B08A3E | #1A1A18 | #6B6F6E |
| mono-white / mono-black | all #FFFFFF / all #111110 | | | |

Wordmark: Inter Display, SemiBold "pewter" + Regular "desk", lowercase. Clear space = one
bar height. Minimum size: mark 16px, horizontal lockup 96px wide. Don't recolor the mid bar.

## Contrast (WCAG 2.1)

All text tokens pass AA (4.5:1) on their background. Exceptions, by design:
`pewter-dim` (3.88 dark) is for hints only; light-mode `brass` fill (2.89) is for fills only.

Known gaps in the original two themes, found when the other four were added
(not yet changed): Pewter's `sell` on `surface-raised` is 4.31:1 (hovered
rows), and Porcelain's `pewter-dim` on `bg` is 2.99:1, just under the 3:1
hint floor.
