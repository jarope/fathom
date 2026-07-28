# Fathom

A lean, native **file manager** for macOS — the day-to-day essentials Finder
makes awkward, done the way the Linux managers (Nautilus, Dolphin, the twin-pane
ones) do them. Started life as *File Finder*; the search is now just one mode of
a proper browser.

Same stack as **Pattern Studio** (Tauri 2 — Rust backend, single vanilla
`index.html`, no npm), themed with the light/dark design system from the
**Fascia** VST.

## What it does today (v0.6.0)

- **Previews** — images (`png/jpg/gif/webp/bmp/svg`, marked 🖼) and **video**
  (`mov/mp4/m4v/avi/mkv/webm/…`, marked 🎬) preview inline. SVGs render natively
  (crisp vector); raster images are downscaled thumbnails; **video** gets a
  poster frame via macOS **Quick Look** (`qlmanage`). Three ways to look, built
  for triaging screenshots and clips:
  - **Docked panel** (🖼 in the header, or ⌘P) — a half-view preview that tracks
    the left pane's selection: **right, 50% width** in single mode; **below the
    left pane, 50% height** in twin mode. Toggle on/off; click it to go full.
  - **Space** — Quick-Look-style **full preview** with dimensions + size; **↑ ↓**
    step through images; right-click / F5 / F6 / ⌫ act on the shown image;
    **Space/Esc** closes. After a move or trash it closes; after a copy it stays.


- **Browse** — opens at your home folder; double-click a folder to enter, with
  **Back / Forward / Up / Home** and an editable **path** bar (type a path, ⏎).
- **Twin-pane** (◫ in the header, or ⌘\\) — two independent panes side by side,
  each with its own path, history, search and selection. The active pane is
  accent-highlighted.
- **Move / copy** —
  - **Drag** a selection to the other pane (or onto a folder) to **move** it;
    hold **⌥** (or **⌃**) while dragging to **copy**.
  - **F6** moves / **F5** copies the selection to the *other* pane.
  - Single-pane: right-click → **Move to… / Copy to…** opens a folder picker.
  - Collisions are never overwritten — a colliding item is auto-renamed
    *"… copy"* (Finder-style). Cross-volume moves fall back to copy-then-remove.
- **Select** — click, ⌘-click to toggle, ⇧-click for a range, ⌘A for all,
  arrow keys to move (⇧ to extend), Esc to clear.
- **Move to Bin** — highlight and press **⌫** or **Delete** (or right-click).
  Uses the **real macOS Trash — recoverable**, never a hard delete.
- **Search within a pane's folder** — type in its search box (wildcards `*` `?`
  ok), ⏎ to run, Esc back to browsing.
- **Open / Reveal / Copy path**, a **Hidden** toggle per pane, and a persisted
  **light / dark** theme (◐).

### Keyboard

| Key | Action |
| --- | --- |
| Space | Full preview of selected image (↑↓ to browse, Space/Esc to close) |
| ⌘P | Toggle the docked preview panel |
| ⏎ | Open selection (enter folder / open file) |
| ⌫ or Delete | Move selection to Bin |
| F5 / F6 | Copy / Move selection to the other pane (twin view) |
| ↑ / ↓ | Move selection (⇧ to extend) |
| ⌘A / Esc | Select all / clear |
| ⌘\\ | Toggle single / twin pane |
| ⌘↑ | Up a folder |
| ⌘[ / ⌘] | Back / Forward |

## Roadmap (added a slice at a time, as needs come up)

- **PDF thumbnails** — the Quick Look path already added for video covers PDFs
  too; just needs wiring in (a page-one thumbnail).
- New folder, rename in place, and other essentials as they're missed.

## Run it

```bash
./scripts/dev.sh      # native dev window, live reload
./scripts/build.sh    # release .app + .dmg → src-tauri/target/release/bundle/
```

Both wrap `cargo tauri` (needs the Tauri CLI). Distributed as an unsigned
`aarch64` DMG — recipients strip quarantine once:
`xattr -dr com.apple.quarantine "/Applications/Fathom.app"` (or right-click →
Open).

## Layout

```
src/index.html          Frontend (single file, Fascia-themed, no npm)
src-tauri/src/lib.rs     Backend: list_dir / home_dir / search / move_to_trash / reveal / open
src-tauri/src/main.rs    Entry point
scripts/                 dev.sh, build.sh
VERSION                  Bump on each feature / fix
```

The app icon is generated from `folder.png` in the repo root
(`cargo tauri icon folder.png`).
