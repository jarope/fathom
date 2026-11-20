# Fathom

A lean, native **file manager** for macOS — the day-to-day essentials Finder
makes awkward, done the way the Linux managers (Nautilus, Dolphin, the twin-pane
ones) do them. Started life as *File Finder*; the search is now just one mode of
a proper browser.

Same stack as **Pattern Studio** (Tauri 2 — Rust backend, vanilla HTML/CSS and
native ES modules in `src/js/`, no npm, no bundler). The look follows
[`DESIGN.md`](DESIGN.md): neutral greys, one accent colour, macOS glass on the
sidebar and popovers, the system font plus JetBrains Mono.

## Install

Fathom runs on macOS 11 (Big Sur) or later, on Apple Silicon and Intel.

**Homebrew**

```bash
brew tap jarope/fathom
brew trust jarope/fathom      # Homebrew 7+ asks you to trust third-party taps once
brew install --cask fathom
```

**Or download** the `.dmg` from
[Releases](https://github.com/jarope/fathom/releases/latest) and drag
Fathom to Applications.

Fathom is free software and isn't notarised by Apple (that needs a paid
Apple Developer account), so the first time you open a downloaded copy macOS
will refuse. Once, either:

- go to System Settings → Privacy & Security and click **Open Anyway**
  (on macOS 14 and earlier, right-click Fathom → **Open** also works), or
- in Terminal: `xattr -dr com.apple.quarantine /Applications/Fathom.app`

Homebrew does this for you. Updates after that install without asking.

**Full Disk Access** (optional): to browse folders macOS keeps private —
Mail, Messages, Safari, Time Machine — turn Fathom on in System Settings →
Privacy & Security → Full Disk Access. Fathom offers to open that page when
you need it.

**Updates** arrive inside the app (once-a-day check; Preferences → General →
Updates). They're signed, and Fathom checks the signature before installing.

## What it does today (v0.31.0)

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

- **Zoom** (⌘+ / ⌘− / ⌘0, or the **Aa** button — or just **scroll over the
  Aa button**, like a Linux volume icon: up = bigger, one wheel click = one
  step) — scales text, icons and rows together from 75% to 160%, so it stays comfortable whether you're on
  the laptop screen or a big external monitor. Remembered between launches;
  the title bar keeps its height so the traffic lights stay lined up.

- **Folder shelf** (on by default; ⇧⌘F or the shelf button to toggle) — a
  folder's sub-folders collapse into **one horizontally scrolling row of
  folder tiles** above the file list, so you never scroll past thirty folders
  to reach the files. The shelf stays at the top while the files scroll
  beneath it; scroll sideways over it (trackpad, a mouse's side wheel like the
  MX Master's thumb wheel, or ⇧-scroll) to move along it, and pinch or
  ⌘-scroll over it to make its folders bigger or smaller. Tiles behave exactly like rows: click/⌘/⇧ select,
  double-click to open, F2 rename, drag, drop-onto, right-click. ← → step
  through them. (Search results stay a plain list.)

- **Places sidebar** (⌃⌘S / F9, or the sidebar button) — Home, Desktop,
  Documents, Downloads, Pictures, Applications, iCloud Drive and mounted
  volumes (with ⏏ eject). **Pin any folder** by dragging it onto the sidebar or
  right-click → *Add to Places*; reorder/remove pins from their right-click
  menu. Drop files onto a place to move them there (⌥ to copy).
  **Recent** (⇧⌘O) lists the last 15 folders you were in (⌘-click for a new
  tab). Network shares get a globe icon.
- **Folder tree** (F7, or *Folders* at the top of the sidebar) — Dolphin's
  Folders panel: a tree rooted at Home (or the volume / disk you're on),
  opened down to the current folder. Click a name to go there, the › to open
  it, ⌘-click for a new tab; ← → ↑ ↓ ⏎ work; drop files on any folder.
- **Connect to Server** (⌘K, or the sidebar) — smb://, afp://, nfs:// or
  WebDAV (https://). macOS mounts it with its own login prompt and Keychain;
  Fathom opens it and remembers the last 10 servers.
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
- **New from Template** (right-click) — anything in `~/Templates` (or the
  folder set in Preferences) is copied in and renamed in place. No folder
  yet? The menu sets one up with starters (Markdown, shell and Python
  scripts, HTML, JSON…).
- **Clipboard** — **⌘X / ⌘C / ⌘V** cut, copy and paste between folders and
  panes (cut items dim until pasted); **⌘D** duplicates in place; right-click a
  folder → *Paste into folder*.
- **Undo / Redo** — **⌘Z** reverses renames, moves, copies, duplicates, new
  items and **Move to Bin** (it puts the items back where they were); **⇧⌘Z**
  redoes (last 50). Undoing a copy/new item sends it to the Bin, and Redo
  brings it back out. Items binned by Fathom also get Finder's own "Put Back".

- **Search** — type to filter the folder; **⏎** searches. The **🔍** button
  picks what ⏎ does: **Names** or **Contents** (Spotlight — text inside
  PDFs, documents, code…), in **this folder and below** or **this Mac**.
  Spotlight results stream in as they're found. Add filters to any search:
  `kind:pdf` `kind:image` `kind:psd` · `modified:<7d` `modified:>2025-01-31`
  `modified:today` · `size:>100MB` · `tag:Red` · `"quoted phrases"`.
  **Save this search…** pins it to the sidebar under *Searches*.

- **Git** — inside a repository, rows are coloured and badged: **M** modified,
  **S** staged, **U** untracked, **!** conflict; ignored files are dimmed and
  folders show the worst change inside them. The status bar shows the branch,
  **↑ ahead / ↓ behind** and how many files changed — click it (or right-click
  → **Git ▸**) for **Commit…** (tick files, write a message, ⌘⏎; *Commit &
  Push* too) and **Push** (sets the upstream on first push; errors shown in
  full). Uses your own `git`, so config, hooks and credentials all apply.
  Refreshes when files change and when you switch back to Fathom.

- **Actions** (like Dolphin's service menus) — right-click → **Actions ▸** runs
  your own shell commands on the selection, or on the folder from the
  empty-space menu. `%f` first item, `%F` all items, `%d` this folder, `%n`
  name. Limit them to files, folders or types (`png, heic`); run in the
  background (progress card with ✕, output shown if asked or on failure) or in
  your terminal app. An action can go in the **Git ▸** menu instead (shown
  only inside a repo). Folder actions are also listed under "This folder" in
  the item menu, and right-clicking the status bar always gives the folder
  menu. Six examples ship (VS Code, Convert to JPEG, SHA-256, Folder size,
  Make executable, and Git log in the Git menu). Stored in
  `~/.config/fathom/actions.json` — edit it by hand or in Preferences.
- **Preferences** (⌘, or the sliders button) — start-up (reopen last tabs or
  a set folder), date style (ISO / system / relative "Yesterday 18:22"),
  terminal app (Terminal, iTerm, Ghostty, Warp), hidden files and shelf.
  Saved in `~/.config/fathom/settings.json`.
- **Shortcuts** — Preferences → Shortcuts lists every command; click **+** and
  press keys to add one, click a key to remove it, ↺ to reset. Taking a key
  from another command says so; macOS's own keys (⌘Q, ⌘H…) are refused.
  Actions can have shortcuts too. Menus show your current keys.

- **Finder tags** — tag dots on rows and folder tiles, the same tags Finder
  uses (set in either app, seen in both). Right-click → colour row or
  **Tags…**; **⌃⌘1–7** toggle your favourite tags, **⌃⌘0** clears. The sidebar
  lists your tags: click one to see everything with it (Spotlight), drop files
  on it to tag them.

- **Open With ▸ / Share… / Quick Look** — right-click → Open With lists the
  apps that can open the selection (default first, with their icons, plus
  Other…); Share… opens the macOS share menu (AirDrop, Messages, Mail…).
  **Space** opens real **Quick Look** — PDFs, video, Office, code… — and ↑ ↓
  keep moving the selection while it's open.

- **Drag & drop with other apps** — drag files out of Fathom into Finder,
  the Desktop, Mail, Slack…, and drag files in from anywhere. Copy or move
  follows Finder's rules: **same disk = move, another disk = copy, hold ⌥ to
  copy, ⌘ to move**. Drops work on rows, folder tiles, breadcrumbs, tabs and
  the sidebar. Inside Fathom (pane to pane, onto a folder) a label follows the
  pointer — ⌥ shows a green +, Esc cancels; carry on out of the window to drop
  into another app.
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
  - **Information panel** (F11 or ⌘P, or the picture button in the header) — a
    panel on the right that follows the active pane: a Quick Look picture of
    the selection (images, PDFs, video, documents; click it for Quick Look),
    name, kind, size, dates, tags and Spotlight facts (dimensions, duration,
    camera…). Folders get their size on demand (*Calculate*); several items
    show how many, kinds and total size; nothing selected shows the folder.
    Drag its left edge to resize. *Get Info…* opens the full window.
  - **Space** — real macOS **Quick Look** (see above); ↑ ↓ move through the
    list while it's open, Space/Esc closes.


- **Browse** — opens where you left off; double-click a folder to enter, with
  **Back / Forward / Up / Home** and an editable **path** bar (type a path, ⏎).
- **Twin-pane** (◫ in the header, or ⌘\\) — two independent panes side by side,
  each with its own path, history, search and selection. The active pane is
  accent-highlighted.
- **Move / copy** —
  - **Drag** a selection to the other pane (or onto a folder): same disk
    **moves**, another disk **copies**; hold **⌥** to copy, **⌘** to move.
  - **F6** moves / **F5** copies the selection to the *other* pane.
  - Right-click → **Copy to ▸ / Move to ▸**: the other pane, recent
    destinations, your Places, or **Other Folder…** to browse for one.
  - Collisions are never overwritten — a colliding item is auto-renamed
    *"… copy"* (Finder-style). Cross-volume moves fall back to copy-then-remove.
- **Select** — click, ⌘-click to toggle, ⇧-click for a range, ⌘A for all,
  arrow keys to move (⇧ to extend), Esc to clear.
- **Move to Bin** — highlight and press **⌫** or **Delete** (or right-click).
  Uses the **real macOS Trash — recoverable**, never a hard delete.
- **The Bin** (sidebar → Locations): browse it; **Put Back** sends items to
  where they came from (Finder's deletions too); **Delete Immediately**
  (⌫ inside the Bin) and **Empty Bin…** ask first. Drop files on the sidebar
  Bin to bin them. macOS only lets apps into the Bin with **Full Disk
  Access**; Fathom explains and opens the right Settings page.
- **Search within a pane's folder** — type in its search box (wildcards `*` `?`
  ok), ⏎ to run, Esc back to browsing. **Recent searches**: click into the
  empty box (or press ↓) for your last 10, with the mode each ran in; ↑ ↓ ⏎
  to run one again, **×** to forget one. While typing, matching ones show.
- **Open / Reveal / Copy path**, a **Hidden files** toggle (◌ in the header, remembered), and a
  **light / dark** switch (◐).
- **Details view** — click a folder's ▸ (or press → / ←) to open it in place
  as a tree; right-click the column header to add Kind, Created, Date Added,
  Extension or Permissions; drag the divider on a column's right edge to resize
  it (Name too — too wide for the pane scrolls sideways; double-click a divider
  to reset). Each folder
  remembers its sort. Only the rows on screen are drawn, so folders with tens
  of thousands of files stay smooth. Apps and other packages open rather than
  browse. (With the folder shelf on, top-level folders are tiles; turn it off
  to expand them in the list.)
- **Grid view** (⌥⌘1, or the grid button; ⌥⌘2 back to Details) — icons and
  real Quick Look thumbnails (photos, PDFs, video, documents) with the Finder
  icon for everything else, custom folder and app icons included. Icon size
  slider in the status bar, or ⌘+ / ⌘− as in Finder. ↑ ↓ ← → move through the grid;
  right-click empty space → **View ▸** and **Sort By ▸**. Each folder remembers
  its view.
- **Columns view** (⌥⌘3, or the columns button) — Finder's column view: the
  folders above on the left with the path highlighted, the current folder,
  and a preview column (a folder's contents, or a file's picture, kind, size
  and dates). → opens the selected folder, ← goes back; click in any column
  to work there. Drop files on any folder or column. Searches show as Details.
- **Open Location** (⇧⌘R, right-click) — for search results, tag views and
  rows inside an expanded folder: goes to the item's folder with it selected
  (Back returns to your results). Hold **⌥** in the menu (or ⌥⇧⌘R) to open it
  in the other pane instead — twin view opens if needed, so your search stays
  put. *Reveal in Finder* is still there, near the bottom of the menu.
- **Get Info** (⌘I, or right-click → Get Info; with nothing selected it's the
  folder itself) — kind, size (folders added up in the background, with a live
  count), where, created / modified / last opened / added, Spotlight facts
  (dimensions, duration, codecs, camera and exposure, pages, version, where it
  was downloaded from), tags to toggle or add, the app it opens with, and
  permissions as read / write / run boxes for owner, group and everyone.
  Several items: total size, kinds and shared tags.
- **Finder icons** — Details and Columns rows show each file's real macOS
  icon (the app's own icon, Downloads / Applications folders, custom folder
  icons), fetched in batches and cached by type. Preferences → General → Show
  → *Finder icons in lists* switches back to simple kind symbols.
- **Grid icon size** — the slider in the status bar, ⌘+ / ⌘−, scrolling over
  the slider, or pinch / ⌘-scroll over the grid: only the icons change size.
- **Rubber-band selection** — drag from empty space to select a box of files
  (⌘ / ⇧ adds to the selection), in Grid and Details.
- **Appearance** (Preferences → General) — Match the system / Light / Dark;
  accent colour follows your macOS accent, or pick Orange, Indigo, Teal,
  Graphite or **any colour** (the rainbow swatch opens the colour picker);
  glass opacity 50–100%.
- **Colour themes** (Preferences → General → Colour theme) — choose one for
  light mode and one for dark; Fathom keeps following macOS's switch.
  Solarized, Nord, Dracula, Gruvbox and Catppuccin are built in. **Import
  Theme…** takes a **base16** scheme (YAML or JSON — there are hundreds), a
  **VS Code colour theme** (the `.json` in an extension's `themes/` folder,
  e.g. `~/.vscode/extensions/*/themes/`), or a Fathom theme
  (`{"name": …, "dark": {"background": …, "text": …, "accent": …}}`) — choose
  the file or paste it. A theme brings its own accent unless you've picked one. Respects **Reduce Transparency** and
  **Increase Contrast**. The sidebar is real macOS glass (window vibrancy), so
  Fathom ships outside the Mac App Store. Every file kind has its own icon
  and tint; the toolbar shows the current folder's name.

### Keyboard

Defaults below — change any of them in Preferences → Shortcuts.

| Key | Action |
| --- | --- |
| ⌘, | Preferences |
| F11 / ⌘P | Information panel |
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
| ⇧⌘R / ⌥⇧⌘R | Open Location — the selected item's folder, here / in the other pane |
| ⇧⌘O | Recent folders |
| F7 | Folder tree ⇄ Places in the sidebar |
| ⌘K | Connect to Server… |
| ⌘[ / ⌘] | Back / Forward |
| ⌘T / ⌘W | New tab / close tab |
| ⌃Tab · ⌘⇧[ ] · ⌘1…9 | Switch tabs |
| ⌃⌘S / F9 | Toggle Places sidebar |
| ⇧⌘F | Toggle the folder shelf |
| ⌘+ / ⌘− / ⌘0 | Zoom in / out / actual size (in grid view ⌘+ / ⌘− size the icons; ⌥⌘+ / ⌥⌘− always zoom) |
| Space | Quick Look |
| ⌘I | Get Info |
| ⌃⌘1…7 / ⌃⌘0 | Toggle favourite tag / clear tags |
| ← / → | Open / close a folder (Details); step through the shelf and the grid |
| ⌥⌘1 / ⌥⌘2 / ⌥⌘3 | Grid / Details / Columns view |
| ⌘+ / ⌘− (grid) | Bigger / smaller icons |
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

Both wrap `cargo tauri` (needs the Tauri CLI).

**Demo folder**: to try everything (or record a demo, or take screenshots)
without showing your own files:

```bash
./scripts/demo.sh            # makes ~/Fathom Demo; --reset recreates it
```

It's all made up: pictures for Grid thumbnails, documents, a Git project with
modified / staged / new files, Finder tags, archives, hidden files, a link,
2,000 log files, and dates spread over two years. Start with
*Read me first.md* inside it.

**Releasing** (maintainers):

```bash
./scripts/release.sh             # universal .app/.dmg + signed update bundle + latest.json → dist/v<VERSION>/
./scripts/release.sh --publish   # …then tag, push the tag and create the GitHub release
```

Before releasing: bump `VERSION` (and `Cargo.toml`, `tauri.conf.json`) and add
the version's section to [`CHANGELOG.md`](CHANGELOG.md) — it becomes the
release notes and the in-app update text. Update signing uses
`~/.tauri/fathom-updater.key` (keep a backup; never commit it) with its
password in the login Keychain (`fathom-updater-key`). `--publish` also
writes the Homebrew cask
([`packaging/homebrew/fathom.rb`](packaging/homebrew/fathom.rb), with the new
version and checksum) to the `jarope/homebrew-fathom` tap.

## Layout

```
src/index.html          Frontend shell (no npm); src/js/ modules, src/css/
src/css/theme.css       Every colour, font and size from DESIGN.md (tokens only)
src/fonts/              JetBrains Mono (SIL OFL, bundled)
src-tauri/src/lib.rs     Backend: list_dir / home_dir / search / move_to_trash / reveal / open
src-tauri/src/main.rs    Entry point
scripts/                 dev.sh, build.sh
VERSION                  Bump on each feature / fix
```

The app icon is generated from `folder.png` in the repo root
(`cargo tauri icon folder.png`).

## Licence

Fathom is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License, version 3 or (at your option) any
later version** — see [`LICENSE`](LICENSE). It comes with no warranty.

JetBrains Mono is included under the SIL Open Font License
([`src/fonts/JetBrainsMono-OFL.txt`](src/fonts/JetBrainsMono-OFL.txt)).
