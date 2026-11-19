# Design spec — colour, type, glass

The visual system for this macOS file manager. Apply these values everywhere; don't invent new colours or sizes. If something isn't covered here, ask.

## Principles

- Neutral greys with a slight cool tint; the user's files carry the colour, not the chrome.
- One accent colour. Default **Orange**. If the user has set a macOS accent colour (System Settings › Appearance), follow it instead (`Color.accentColor` / `NSColor.controlAccentColor`), and offer Orange, Indigo, Teal and Graphite as in-app choices.
- Glass only on chrome that sits over other content: the sidebar, toolbar control groups, popovers, the path bar. File lists and the inspector stay opaque.
- Respect **Reduce Transparency** (glass becomes solid) and **Increase Contrast**.
- Every text colour below passes WCAG AA (4.5:1) on the surfaces it is used on. Don't lighten secondary/tertiary text.

## Colour tokens

### Surfaces and text

| Token | Light | Dark | Use |
|---|---|---|---|
| `window` | `#F4F5F7` | `#14161A` | Window background behind panes |
| `content` | `#FBFBFC` | `#202329` | File list, inspector |
| `rowHover` | `#F0F1F4` | `#2A2E36` | Hovered row |
| `separator` | `rgba(20,24,33,0.08)` | `rgba(255,255,255,0.07)` | Hairlines, column header rule |
| `text` | `#1B1D22` | `#ECEEF2` | Primary text, file names |
| `text2` | `#5A6070` | `#A4AAB6` | Dates, sizes, kinds, secondary labels |
| `text3` | `#656B7A` | `#9096A3` | Sidebar section labels, status bar, placeholders |
| `disabled` | `#B4B9C4` | `#555B67` | Disabled controls (not for readable text) |

Content is deliberately not pure white / near-black, so the sidebar and content panes sit close in tone.

### Accent

| Accent | Light | Dark | Text on accent fill |
|---|---|---|---|
| **Orange (default)** | `#C8480C` | `#FF9A52` | `#FFFFFF` (light) / `#14161A` (dark) |
| Indigo | `#4A55D0` | `#8E96F2` | same rule |
| Teal | `#0B7480` | `#4CC2CB` | same rule |
| Graphite | `#464B57` | `#BAC0CB` | same rule |

Accent is used for: selected row fill, the active segment in segmented controls, focus rings, links, sidebar Favourites icons. In dark mode, text on an accent fill is dark (`#14161A`), not white.
Don't use a brighter orange (e.g. `#E8620C`) for text or selection fills; it fails contrast. It's fine for large graphics only.

### Status

| | Light | Dark |
|---|---|---|
| Success | `#1C7F46` | `#52C58D` |
| Warning | `#9A5B00` | `#EDB24E` |
| Danger | `#C02D2B` | `#F27873` |

Always pair status colour with an icon or label.

### File-kind icon tints

Each kind also has its own glyph; colour is never the only signal. All are ≥3:1 on light content.

| Kind | Tint |
|---|---|
| Folder | `#3F76DE` |
| Document | `#5E6B80` |
| Image | `#23905F` |
| Video | `#7C52CC` |
| Audio | `#C8457F` |
| Code | `#5B5BD6` |
| Archive | `#93703A` |
| App | `#14909B` |

Selected rows: icon and all text switch to the "text on accent" colour.

### Sidebar tags

Work `#4A55D0` · Personal `#0B7480` · To review `#C8480C` (shown as 9pt dots).

## Glass material

Native SwiftUI first: use the system glass/material APIs for the current macOS (`.glassEffect()` where available, otherwise `.background(.regularMaterial)` / `NSVisualEffectView` with `.sidebar` / `.headerView`). Don't fake glass with custom blur if the system material is available. Use the values below to tune tint, or for non-native renders (website, screenshots).

| | Light | Dark |
|---|---|---|
| Fill | `rgba(236,238,242,0.80)` | `rgba(42,45,52,0.80)` |
| Top sheen (top 40%, fading out) | white at 45% | white at 5% |
| Blur | 60px | 60px |
| Saturation | 115% | 115% |
| Inner top highlight | 1px white at 90% | 1px white at 10% |

- Sidebar runs edge to edge (not a floating card), with a hairline `separator` on its right.
- Toolbar control groups are pill-shaped capsules: fill `rgba(255,255,255,0.72)` light / `rgba(255,255,255,0.06)` dark, with a 1px inner top highlight and a hairline edge.
- Offer a user setting for glass opacity from 50% to 100% (default 80%). 100% = solid, the same as Reduce Transparency.

## Shape

- Window corner radius: follow the system (don't override).
- Controls: capsule (fully rounded). Rows and sidebar items: 8pt radius. Cards/popovers: 14pt. Keep corners concentric (inner radius = outer radius − padding).
- Row height 34pt in list view; sidebar item 30pt. Hit targets for toolbar buttons ≥ 30pt tall with generous width.

## Typography

Two families only.

- **UI: the system font (SF Pro).** SwiftUI text styles (`.body`, `.headline` …) so Dynamic Type / Accessibility text size scales everything. Don't bundle SF and don't hard-code point sizes where a text style exists.
- **Mono: JetBrains Mono** (SIL Open Font License, bundle it) for path bar, "Go to folder", hashes, code previews. Fallback: `.monospaced()` design (SF Mono).
- Size, date and count columns use the system font with **tabular figures** (`.monospacedDigit()`), right-aligned for sizes. Not mono.
- Headings: bolder weights, left-aligned. No custom letter-spacing on body text.

| Style | Size / line (pt) | Weight | Used for |
|---|---|---|---|
| Large Title | 26 / 32 | Bold | Empty states, onboarding |
| Title 2 | 17 / 22 | Semibold | Window title, inspector heading |
| Title 3 | 15 / 20 | Semibold | Group headers in lists, toolbar location name |
| Headline | 13 / 16 | Semibold | Selected item, emphasised labels |
| Body | 13 / 16 | Regular | File names, list rows, menus |
| Callout | 12 / 15 | Regular | Secondary metadata, tooltips |
| Subheadline | 11 / 14 | Semibold, +0.02em | Sidebar section labels, column headers |
| Footnote | 10 / 13 | Regular | Status bar |
| Mono | 12 / 16 | Regular (JetBrains Mono) | Path bar, Go to folder, code preview |

## Implementation notes

- Put every value above in one theme file (e.g. asset-catalog colour sets with Any/Dark appearances, plus a `Theme` struct). No raw hex values in views.
- Accent: a single `accent` token resolved from user setting → system accent → Orange.
- Check both appearances, Increase Contrast and Reduce Transparency before calling a screen done.
