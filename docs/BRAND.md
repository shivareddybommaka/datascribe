# Brand

Source: https://datascribetech.com/contact.html (logo, favicon and `style.css`), fetched 2026-10-23.
Tokens live in `apps/web/app/globals.css` (`@theme`). Change colours there only.

## Assets

| File                                                         | Source                                           | Notes                    |
| ------------------------------------------------------------ | ------------------------------------------------ | ------------------------ |
| `apps/web/public/brand/datascribe-logo.png`                  | `assets/images/Datascribe-technologies-logo.png` | 438×108, transparent PNG |
| `apps/web/public/brand/favicon.png`, `apps/web/app/icon.png` | `assets/images/fav.png`                          | 302×347, the "S" mark    |

Raster only. Ask Datascribe for an SVG logo before launch (sharper at all sizes and on dark backgrounds).

## Colours

| Token                  | Hex       | Where it came from                                                  |
| ---------------------- | --------- | ------------------------------------------------------------------- |
| `brand-600` (primary)  | `#026cb8` | Logo wordmark "DATASCRIBE" (most common pixel colour)               |
| `brand-500`            | `#106eea` | Site link / selection colour (most used non-neutral in `style.css`) |
| `navy-600` (secondary) | `#2a3695` | Dark end of the logo "S" gradient                                   |
| `navy-800`             | `#1c3988` | Site `.blue-bg` buttons                                             |
| `navy-900`             | `#090e40` | Site deep navy                                                      |
| `ink`                  | `#1c1b1b` | Site headings                                                       |
| `body`                 | `#363636` | Site body text                                                      |
| `surface` / `brand-50` | `#f1f6fc` | Site light section background                                       |

The other `brand-*` and `navy-*` steps are interpolated to fill out the scale.
`bg-brand-gradient` = 135° `brand-600` to `navy-600`, matching the logo mark.

The site's other colours (`#ec4c6f`, `#67c27c`, `#b1976b`, …) come from its theme template's demo
variants. They aren't Datascribe brand colours and are deliberately left out.

## Contrast (WCAG 2.1 AA, §10)

- `brand-600` on white: about 5.5:1, OK for body text and white-on-brand buttons.
- `brand-500` on white: about 4.7:1, OK for normal text but tight; prefer 600+ for small text.
- Don't put `brand-400` or lighter behind white text.
