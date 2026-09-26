# Flags

4:3 country flags for the language picker, copied from
[flag-icons](https://github.com/lipis/flag-icons) v7.5.0 (`flags/4x3/`), MIT —
see `LICENSE` here. Bundled rather than loaded from a URL because the webview's
CSP (`img-src 'self' data:`) doesn't allow remote images, and shouldn't.

To add one, copy `flags/4x3/<iso-code>.svg` from the same release, check it
has no `<script>`, event handlers or external `href`s, and export it from
`assets/index.ts`.
