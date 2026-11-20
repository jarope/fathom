# Changelog

What changed in each version of Fathom. The newest is at the top. The
release script uses the section for the version it's building as the release
notes (and the text shown in the in-app update card), so keep each section
short and written for people who use Fathom.

## 0.28.0 — 2026-11-20

- **The Bin** in the sidebar: browse it, **Put Back** items to where they
  came from (including things you binned in Finder), **Delete Immediately**
  and **Empty Bin**. Drop files on it to bin them. Needs Full Disk Access.

## 0.27.3 — 2026-11-20

- After an update, Fathom says so: a small card on the first launch with a
  link to what's new.
- Preferences → General → Updates shows which version you have.

## 0.27.2 — 2026-11-20

- **New app icon**: a sounding line dropping through stacked folders.

## 0.27.1 — 2026-11-20

- Fixed: the folder shelf showed plain blue folder symbols instead of the
  real Finder icons (yellow folders, Downloads, apps, custom icons).

## 0.27.0 — 2026-11-20

- **Updates**: Fathom checks GitHub once a day and shows a small card when a
  new version is out: *Install & Relaunch*, *Skip This Version* or close it.
  Downloads are verified against Fathom's signing key before anything is
  replaced. Preferences → General → Updates turns it off or checks now.
- **Full Disk Access help**: opening a folder macOS keeps private (Mail,
  Safari, Time Machine…) explains why and opens the right Settings page.
- macOS permission prompts (Desktop, Documents, Downloads, external and
  network drives, asking Finder to use the Bin) now say what Fathom needs
  them for.
- Releases are universal (Apple Silicon and Intel).

## 0.26.0 — 2026-11-20

- **Colour themes**: one for light mode, one for dark. Solarized, Nord,
  Dracula, Gruvbox and Catppuccin built in; import base16 schemes, VS Code
  colour themes or Fathom theme files.
- **Custom accent colour** — any colour from the colour picker.
- **Recent searches** under the search box, with × to forget one.
- Fixed: rows could peek through a thin gap between the pinned folder shelf
  and the column header.

## 0.25.0 — 2026-11-20

- **Scroll-wheel controls**: scroll over the zoom (Aa) button to zoom; over
  the icon-size slider, or pinch / ⌘-scroll over the grid, to size icons.
- **Folder shelf** stays pinned while the files scroll; pinch / ⌘-scroll
  sizes its folders; sideways scrolling (trackpad, a mouse's side wheel,
  ⇧-scroll) moves along it.
- Fathom is now free software under the GNU GPL v3 or later.

## 0.24.0 — 2026-11-20

- **Information panel** (F11 / ⌘P): picture, details and Spotlight facts for
  the selection, folder sizes on demand. Replaces the preview dock.
- **Open Location** (⇧⌘R) for search results and expanded rows; hold ⌥ (or
  ⌥⇧⌘R) to open it in the other pane.
- Fixed: pictures in the Columns preview and Get Info could stay as plain
  symbols.

## 0.23.0 — 2026-11-20

- Real **Finder icons** in Details and Columns rows (app icons, special and
  custom folder icons). Preferences can switch back to simple symbols.

## 0.22.0 — 2026-11-20

- **Get Info** (⌘I): kind, size (folders counted in the background), dates,
  Spotlight facts, tags, default app and permissions.

## 0.21.0 — 2026-11-19

- **Columns view** (⌥⌘3), Finder style, with a preview column.

## 0.20.0 – 0.20.1 — 2026-11-19

- **Grid view** (⌥⌘1) with Quick Look thumbnails and an icon-size slider;
  rubber-band selection.
- Copy to ▸ / Move to ▸ menus with an in-app folder picker.
- Drag & drop rebuilt: pane to pane, and out to other apps, works reliably.
- Column dividers resize the column on their left.

## 0.19.0 — 2026-11-19

- New display engine: huge folders stay smooth. Details view with folders
  that expand in place, choosable and resizable columns, per-folder sorting.

## 0.18.0 — 2026-11-19

- Visual redesign: neutral greys, one accent colour, macOS glass.

## 0.17.0 — 2026-11-19

- Your own right-click **actions**, **Preferences** (⌘,) and a **shortcut
  editor**.

## 0.16.0 — 2026-11-19

- **Git** status badges, branch chip, Commit… and Push.

## 0.15.0 — 2026-11-18

- **Spotlight search** (names or contents, here or the whole Mac), query
  filters (kind:, modified:, size:, tag:) and saved searches.

## 0.14.0 — 2026-11-18

- Finder **tags**, **Open With**, **Share** and real **Quick Look**.

## 0.13.0 — 2026-11-18

- Drag & drop with other apps, Redo, and Put Back from the Bin.

## 0.11.0 – 0.12.0 — 2026-11-18

- Copies and moves in the background with progress and cancel; the
  "already exists" dialog; Finder clipboard; compress / extract; batch
  rename; window zoom.

## 0.8.0 – 0.10.0 — 2026-11-18

- Dolphin-style essentials: Places sidebar, tabs, breadcrumbs, folder shelf,
  auto-refresh, session restore.

## 0.6.0 – 0.7.0 — 2026-07-28

- First versions: a lean twin-pane file manager for macOS; column sorting.
