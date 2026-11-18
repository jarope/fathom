# Fathom roadmap — a Dolphin-class file manager for macOS

Goal: a native macOS file manager that does what KDE **Dolphin** does well, so
Finder becomes optional — and that is polished enough to release publicly.

Status key: ✅ done · 🟡 partial · ⬜ not started

## Gap analysis vs Dolphin

| Area | Dolphin | Fathom |
| --- | --- | --- |
| **Split view** (F3) | Two panes, independent | ✅ twin pane (⌘\\) |
| **Create new** | Folder (F10), file from templates | ✅ folder (⇧⌘N / F10 / ＋), text file (⌥⌘N) · ⬜ templates |
| **Rename** | Inline (F2), batch rename | ✅ inline F2 · ✅ batch rename with preview |
| **Clipboard** | Cut / copy / paste, paste into folder | ✅ ⌘X ⌘C ⌘V, paste into folder, Finder pasteboard both ways, ⌥⌘V move |
| **Duplicate** | Ctrl+D | ✅ ⌘D |
| **Undo / redo** | Ctrl+Z for file operations | ✅ undo rename / move / copy / create · ⬜ redo, undo of Bin |
| **Filter bar** (Ctrl+I) | Live filter of current folder | ✅ search box filters live; ⏎ searches recursively |
| **Type-ahead** | Jump to name as you type | ✅ |
| **Free space** in status bar | ✅ | ✅ |
| **Open Terminal here** / Terminal panel (F4) | Embedded panel | ✅ opens Terminal.app (⌥⌘T) · ⬜ embedded panel |
| **Background context menu** | New, paste, terminal, view options | ✅ |
| **Tabs** (Ctrl+T) | Tabs per window, each optionally split | ✅ ⌘T, each tab single/twin, drop onto tabs |
| **Places panel** | Home, Desktop, Downloads, devices, network, bookmarks, recent | ✅ favourites, pins, iCloud, volumes + eject · ⬜ recent, network |
| **Breadcrumb location bar** | Clickable segments with sub-folder drop-downs; Ctrl+L to edit | ✅ segments, › drop-downs, ⌘L to type, drop targets |
| **View modes** | Icons, Compact, Details, Columns (back in 2026) | 🟡 details only · ⬜ icons/grid, columns |
| **Zoom** | Ctrl+wheel / slider | ⬜ |
| **Expandable folders** in details view | Tree in list | ⬜ |
| **Folders panel** | Tree sidebar | ⬜ |
| **Information panel** | Preview + metadata of selection | 🟡 docked image/video preview · ⬜ metadata, PDF, text |
| **Auto-refresh** | Watches folders (KDirWatch) | ✅ FSEvents via `notify` |
| **Progress / cancel** for long ops | KIO job tracker | ✅ job cards: bar, speed, ETA, cancel |
| **Conflict dialog** | Overwrite / skip / rename / apply-to-all | ✅ keep both / replace (→ Bin) / skip / merge, apply to all |
| **Properties dialog** | Size (recursive), permissions, dates, open-with | ⬜ |
| **Open With…** | App chooser | ⬜ |
| **Service menus / actions** | Extensible right-click actions | ⬜ (later: user scripts → menu) |
| **Archives** | Compress / extract via Ark | ✅ compress (zip) / extract (zip, tar, 7z, rar…) |
| **Trash view** | Browse + restore | ⬜ (needs "Put Back") |
| **Tags / ratings** | Baloo | ✅ Finder tags: dots, menu, ⌃⌘1–7, sidebar, drop-to-tag |
| **Content search** | Baloo | ✅ Spotlight: contents / names, here or whole Mac, streamed; saved searches |
| **Remote locations** | sftp, smb, etc. via KIO | ⬜ mounted volumes only for now |
| **Git status overlays** | Plugin | ⬜ |
| **Per-folder view settings** | Remembered | ⬜ |
| **Session restore** | Tabs/paths reopened | ✅ tabs, folders, layout, sort, window size |
| **Customisable shortcuts** | Any action (26.04) | ⬜ |
| **Folder shelf** (Fathom original) | — | ✅ sub-folders as one scrolling row of tiles above the files |
| **Native file icons / thumbnails** | | 🟡 emoji + Quick Look thumbs (real icons in Open With) |
| **Drag to/from other apps** | | ✅ native drag sessions both ways |

## Phases

### Phase 1 — Finder-replacement blockers ✅ (v0.8.0)
New folder/file, inline rename, cut/copy/paste, duplicate, undo, live filter,
type-ahead, background menu, Open Terminal Here, free space, more shortcuts.

### Phase 2 — Structure & navigation ✅ (v0.9.0)
Frontend split into ES modules (`src/js/`, no npm); Places sidebar with pins,
iCloud and volumes (eject); tabs; breadcrumb path bar with sub-folder
drop-downs; FSEvents auto-refresh; session + window-size restore. Long folders
use `content-visibility` for cheap rendering — a true **virtualised list**
moves to Phase 5 alongside the grid view, which needs the same machinery.

### Phase 3 — Operations done properly ✅ (v0.11.0)
Job engine with progress, speed/ETA and cancel; conflict dialog (keep both /
replace-to-Bin / skip / merge, apply to all); Finder pasteboard interop both
ways (+ ⌥⌘V move); compress / extract; batch rename with live preview. Undo
covers all of it (merged moves undo piece by piece).

### Zoom ✅ (v0.12.0)
⌘+ / ⌘− / ⌘0 and an **Aa** menu: whole-window zoom 75–160%, remembered;
the title bar stays 64pt so the traffic lights stay aligned.

### Phase 3b — Drag & drop with other apps ✅ (v0.13.0)
All drags are native macOS drag sessions: files drag out to Finder, Mail,
Slack…, and drops from anywhere (Fathom included) arrive through Tauri's drop
events, hit-tested against rows, tiles, breadcrumbs, tabs and the sidebar.
Finder's copy/move rules (same disk = move, ⌥ copy, ⌘ move). **Redo** (⇧⌘Z)
and **undo for Move to Bin** (Bin location recorded; Finder's Put Back works
too). Symlinks go to the Bin via NSFileManager — Finder can't bin them by path.

### Phase 4 — Mac-native power (next)
Shipped in four steps:

**v0.14 — Tags & system integration** ✅
- **Finder tags**: coloured dots on rows (read from Finder's own tag data, so
  tags set in either app show in both); tag/untag from the right-click colour
  row and ⌃⌘1–7 (⌃⌘0 clears); written through NSURL so Spotlight stays right.
- **Tags in the sidebar**: click one to list every file with that tag (Spotlight).
- **Open With ▸**: apps that can open the selection (default first) + Other….
- **Share ▸**: the standard macOS share menu (AirDrop, Messages, Mail…).
- **Real Quick Look on Space** (QLPreviewPanel): PDFs, video, Office, code…
  replaces Fathom's image-only full preview; ↑ ↓ keep moving the selection.

**v0.15 — Spotlight search** ✅
- Filter box gets a **Name / Contents** switch; Contents = Spotlight
  (`mdfind -onlyin`), results stream in; this folder or the whole Mac.
- Query helpers: `kind:pdf`, `modified:<7d`, `size:>100MB`, `tag:Red`.
- **Saved searches** pinned in the sidebar (Smart Folders).

**v0.16 — Git**
- Rows coloured/badged: modified, new, staged, conflicted; ignored dimmed;
  folders roll up their contents' status; branch + ahead/behind in the status bar.
- Refreshes on file changes (FSEvents watcher already in place).
- **Simple commit & push**: right-click → *Commit…* (pick files, message,
  commit) and *Push* to the tracking remote — progress card, errors shown in
  full; anything fancier stays in your git tools.

**v0.17 — User actions, Preferences, Shortcuts**
- **User actions** (Dolphin service menus): right-click entries defined in
  `~/.config/fathom/actions.json` **and** editable in Preferences (same file).
  `%f` file, `%F` all selected, `%d` current folder; filter by type / folders /
  multi; run in background (progress card) or in Terminal. Ships with examples.
- **Preferences window**: start folder, defaults (hidden, shelf), date format,
  terminal app (Terminal / iTerm / Ghostty / Warp), session restore.
- **Shortcut editor**: rebind any action, clash warnings.

### Phase 5 — Views & information (after Phase 4)
- **Display engine**: shared per-pane model (entries, sort, filter, selection)
  + views that draw only what's on screen — 50k-entry folders stay smooth;
  selection, rename, type-ahead, drag & drop, menus work in every view.
- **Details view**: expandable folders (tree), choosable/resizable columns
  (Kind, Created, Added, Extension, Permissions), per-folder view memory.
- **Grid view** with Quick Look thumbnails, icon size, rubber-band selection.
- **Columns view** (Miller columns) with a preview column.
- **Real file icons** (NSWorkspace) instead of emoji, cached per type.
- **Information panel** (Dolphin F11) replacing the preview dock: preview,
  metadata (dimensions, duration, EXIF), folder size on demand.
- **Get Info** (⌘I): recursive size, permissions, dates, Open With, tags.
- Open questions: ⌘+/⌘− in grid view = icon size (window zoom → ⌥⌘+/−)?

### Phase 6 — Public release (v1.0)
- **Name check**: "Fathom" is already used by Fathom Analytics and the Fathom
  AI meeting notetaker — check the trademark before going public; a rename is
  cheap now and expensive later.
- **Licence** choice (GPL-3.0 matches the Dolphin heritage; MIT/Apache if you
  want maximum reuse).
- **Developer ID signing + notarisation** (Apple Developer Program) — otherwise
  Gatekeeper blocks it for everyone else. Add `scripts/release.sh`.
- **Auto-update** via `tauri-plugin-updater` + GitHub Releases.
- **Homebrew cask**; screenshots, a landing page, CHANGELOG.md.
- Full Disk Access guidance (protected folders like Mail, Safari).
- Accessibility pass (VoiceOver labels, focus rings, keyboard-only use).
- Remove personal info from defaults (authors/copyright are fine; nothing else).

## Polish backlog (after feature-complete, before daily-driver)
Deferred on purpose — features first, then a polish pass.
- Header: confirm traffic-light vertical alignment and wordmark spacing on a real build.
- Folder shelf: optional mouse-wheel → sideways scroll while hovering the shelf.
- Drag cursor always shows the "+" (copy) badge over Fathom, even when the
  drop will move — Tauri's drop handler always answers "copy" to AppKit.
- Other header/layout tweaks noted during v0.8–0.10 review (to be listed).
