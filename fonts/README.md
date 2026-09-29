# Fonts

Self-hosted WOFF2 files so Rackplanner renders the same offline. They are
loaded by `css/fonts.css` and precached by `sw.js`.

| Family           | Weights       | Source (npm)                        | Upstream               |
| ---------------- | ------------- | ----------------------------------- | ---------------------- |
| Barlow           | 400, 500, 600 | `@fontsource/barlow` 5.3.0          | Google Fonts v13       |
| Barlow Condensed | 500, 600      | `@fontsource/barlow-condensed` 5.3.0 | Google Fonts v13       |
| IBM Plex Mono    | 400, 500, 600 | `@fontsource/ibm-plex-mono` 5.3.0   | Google Fonts v20       |

Normal style only, `latin` and `latin-ext` subsets, copied unmodified from
each package's `files/` directory.

## License

These fonts are **not** CC0 like the rest of the project. They are licensed
under the SIL Open Font License 1.1; see [`OFL.txt`](OFL.txt) for the
copyright notices and full license text.

- Barlow, Barlow Condensed: Copyright 2017 The Barlow Project Authors
- IBM Plex Mono: Copyright 2017 IBM Corp., Reserved Font Name "Plex"
