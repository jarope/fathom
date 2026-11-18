# Fathom

A lean, native **file manager** for macOS — the day-to-day essentials Finder
makes awkward, done the way the Linux managers (Nautilus, Dolphin, the twin-pane
ones) do them. Started life as *File Finder*; the search is now just one mode of
a proper browser.

Same stack as **Pattern Studio** (Tauri 2 — Rust backend, vanilla HTML/CSS and
native ES modules in `src/js/`, no npm, no bundler), themed with the light/dark design system from the
**Fascia** VST.

## What it does today (v0.13.0)

- **Progress & cancel** — copies, moves, duplicates and archive jobs run in the
  background; anything that takes more than a moment gets a card (bottom-right)
  with a progress bar, speed, time left, the current file, and **✕ to cancel**.
  Cancelling cleans up the half-copied item; what already finished stays (and
  ⌘Z undoes it). Same-disk copies stay instant (APFS clones).
- **"Already exists" dialog** — when a copy/move/paste/drop would clash, choose
  per item **Keep both** (“… copy”), **Replace** (the old one goes to the
  **Bin**, never deleted), **Skip**, or for folders **Merge**; or *Apply to all*.
  Shows both sizes/dates and flags the newer one.
- **Finder clipboard** — ⌘C in Fathom → ⌘V in Finder, Mail, Slack… and files
  copied in Finder paste into Fathom. **⌥⌘V** moves them here instead.
- **Compress / Extract** (right-click) — *Compress* makes `name.zip` (or
  `Archive.zip`) like Finder; *Extract here* handles zip, tar, gz, bz2, xz, 7z,
  rar… One top-level item comes out as itself; several land in a folder.
- **Batch rename** — select several and press **F2** (or right-click → *Rename
  N items…*): replace text (optionally regex), add text before/after, number
  them (“Holiday 01.jpg”), or change case — with a live preview that flags
  duplicates before anything happens. Swaps (a↔b) are safe; ⌘Z undoes.

- **Zoom** (⌘+ / ⌘− / ⌘0, or the **Aa** button) — scales text, icons and
  rows together from 75% to 160%, so it stays comfortable whether you're on
  the laptop screen or a big external monitor. Remembered between launches;
  the title bar keeps its height so the traffic lights stay lined up.

- **Folder shelf** (on by default; ⇧⌘F or the shelf button to toggle) — a
  folder's sub-folders collapse into **one horizontally scrolling row of
  folder tiles** above the file list, so you never scroll past thirty folders
  to reach the files. Tiles behave exactly like rows: click/⌘/⇧ select,
  double-click to open, F2 rename, drag, drop-onto, right-click. ← → step
  through them. (Search results stay a plain list.)

- **Places sidebar** (⌃⌘S / F9, or the sidebar button) — Home, Desktop,
  Documents, Downloads, Pictures, Applications, iCloud Drive and mounted
  volumes (with ⏏ eject). **Pin any folder** by dragging it onto the sidebar or
  right-click → *Add to Places*; reorder/remove pins from their right-click
  menu. Drop files onto a place to move them there (⌥ to copy).
- **Tabs** — ⌘T new tab, ⌘W close, ⌃Tab / ⌘⇧[ ] to cycle, ⌘1…9 to jump.
  Middle-click or ⌘-double-click a folder (or ⌘-click a place) to open it in a
  new tab. Each tab keeps its own single/twin layout. The tab bar only shows
  once you have two; drag files onto a tab to move them there (hover to open it).
- **Breadcrumb path bar** — click any folder in the path to jump there; click a
  **›** to list that folder's sub-folders; click blank space (or ⌘L) to type a
  path (`~` works). Drop files on a path segment to move them up there.
- **Auto-refresh** — folders on screen update by themselves when files change
  (macOS FSEvents), keeping your selection, scroll and filter.
- **Remembers your session** — tabs, folders, layouts and sort order come back
  on relaunch, along with the window size and position.

- **Create & rename** — **New Folder** (⇧⌘N, F10, ＋ next to Up, or right-click) and
  **New Text File** (⌥⌘N) drop straight into an inline rename; **F2** renames
  in place (the name is pre-selected without its extension). Never overwrites.
- **Clipboard** — **⌘X / ⌘C / ⌘V** cut, copy and paste between folders and
  panes (cut items dim until pasted); **⌘D** duplicates in place; right-click a
  folder → *Paste into folder*.
- **Undo / Redo** — **⌘Z** reverses renames, moves, copies, duplicates, new
  items and **Move to Bin** (it puts the items back where they were); **⇧⌘Z**
  redoes (last 50). Undoing a copy/new item sends it to the Bin, and Redo
  brings it back out. Items binned by Fathom also get Finder's own "Put Back".

- **Drag & drop with other apps** — drag files out of Fathom into Finder,
  the Desktop, Mail, Slack…, and drag files in from anywhere. Copy or move
  follows Finder's rules: **same disk = move, another disk = copy, hold ⌥ to
  copy, ⌘ to move**. Drops work on rows, folder tiles, breadcrumbs, tabs and
  the sidebar.
- **Live filter** — typing in a pane's search box filters the folder as you
  type (wildcards ok); **⏎** searches all subfolders. ⌘F focuses it, ⌘L the path.
- **Type-ahead** — type a name's first letters to jump to it.
- **Folder menu** — right-click empty space for New Folder/File, Paste,
  **Open Terminal Here** (⌥⌘T), Copy folder path, show hidden (⇧⌘.).
- **Free space** for the current volume in each pane's status bar.

- **Sort** — click any column header (**Name / Folder / Size / Modified**) to
  sort; click again to reverse. Name sorts A→Z first, size/date largest/newest
  first; folders always stay on top. The active column shows a ▲/▼ arrow, and
  the choice sticks as you navigate.


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


- **Browse** — opens where you left off; double-click a folder to enter, with
  **Back / Forward / Up / Home** and an editable **path** bar (type a path, ⏎).
- **Twin-pane** (◫ in the header, or ⌘\\) — two independent panes side by side,
  each with its own path, history, search and selection. The active pane is
  accent-highlighted.
- **Move / copy** —
  - **Drag** a selection to the other pane (or onto a folder): same disk
    **moves**, another disk **copies**; hold **⌥** to copy, **⌘** to move.
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
- **Open / Reveal / Copy path**, a **Hidden files** toggle (◌ in the header, remembered), and a persisted
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
| ⇧⌘N / F10 | New folder (then type its name) |
| ⌥⌘N | New text file |
| F2 | Rename in place (several selected → batch rename) |
| ⌘X / ⌘C / ⌘V | Cut / copy / paste (shared with Finder) |
| ⌥⌘V | Move clipboard files here |
| ⌘D | Duplicate |
| ⌘Z / ⇧⌘Z | Undo / redo last file operation |
| ⌘F / ⌘L | Focus filter / type a path |
| ⇧⌘. | Show / hide hidden files |
| ⌥⌘T | Open Terminal here |
| a–z | Jump to name (type-ahead) |
| ⌘\\ | Toggle single / twin pane |
| ⌘↑ | Up a folder |
| ⌘[ / ⌘] | Back / Forward |
| ⌘T / ⌘W | New tab / close tab |
| ⌃Tab · ⌘⇧[ ] · ⌘1…9 | Switch tabs |
| ⌃⌘S / F9 | Toggle Places sidebar |
| ⇧⌘F | Toggle the folder shelf |
| ⌘+ / ⌘− / ⌘0 | Zoom in / out / actual size |
| ← / → | Step through the folder shelf |
| ⇧⌘H | Home |
| ⌘R | Refresh |

## Roadmap

The goal is a Dolphin-class file manager for macOS, released publicly — see
**[ROADMAP.md](ROADMAP.md)** for the feature-by-feature gap analysis against
KDE Dolphin and the phased plan (sidebar, tabs, views, job progress, Finder
tags, signing/notarisation…).

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
