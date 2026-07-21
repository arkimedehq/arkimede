# Bundled webfonts — provenance and license

These fonts are **self-hosted on purpose**. The landing page loads no third-party CDN,
so a visitor's IP address and User-Agent never reach Google or anyone else. A page that
argues for data sovereignty should not leak its readers' data to load a typeface.

Both families are licensed under the **SIL Open Font License 1.1**, which explicitly
permits bundling, redistribution and modification, including inside a larger work.
The OFL requires the license text to travel with the fonts — hence the two `OFL-*.txt`
files in this directory. Neither font may be sold on its own, which we do not do.

| Font | Role | License | Upstream source |
|---|---|---|---|
| **Space Grotesk** | Display (headings, wordmark) | [SIL OFL 1.1](./OFL-space-grotesk.txt) | [floriankarsten/space-grotesk](https://github.com/floriankarsten/space-grotesk) — © 2020 The Space Grotesk Project Authors |
| **IBM Plex Sans** | Body text | [SIL OFL 1.1](./OFL-ibm-plex.txt) | [IBM/plex](https://github.com/IBM/plex) — © 2017 IBM Corp., Reserved Font Name "Plex" |
| **IBM Plex Mono** | Labels, commands, data | [SIL OFL 1.1](./OFL-ibm-plex.txt) | [IBM/plex](https://github.com/IBM/plex) — © 2017 IBM Corp., Reserved Font Name "Plex" |

## What is in here

The `.woff2` files are the Latin and Latin-Extended subsets, as distributed by the Google
Fonts CDN (which serves the upstream OFL binaries unmodified). Subsetting to Latin keeps
the whole set at ~170 KB.

- **Space Grotesk and IBM Plex Sans are variable fonts** — one file covers the entire
  weight range, and `fonts.css` declares a weight *range* (`300 700` / `100 700`) so the
  browser interpolates. Declaring a single fixed weight against a variable file would
  collapse every weight to the default and silently flatten the typography.
- **IBM Plex Mono is static** — one file per weight (400, 500).

## Refreshing them

Re-download the same subsets from the Google Fonts CSS API, keeping only the `latin` and
`latin-ext` `@font-face` blocks, then re-check whether a family is still variable (same
file URL across weights) before editing `fonts.css`.
