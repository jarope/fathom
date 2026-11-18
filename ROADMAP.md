# Fathom roadmap — a Dolphin-class file manager for macOS

Goal: a native macOS file manager that does what KDE **Dolphin** does well, so
Finder becomes optional — and that is polished enough to release publicly.

Status key: ✅ done · 🟡 partial · ⬜ not started

## Gap analysis vs Dolphin

| Area | Dolphin | Fathom |
| --- | --- | --- |
| **Split view** (F3) | Two panes, independent | ✅ twin pane (⌘\\) |
| **Create new** | Folder (F10), file from templates | ✅ folder (⇧⌘N / F10 / ＋), text file (⌥⌘N) · ⬜ templates |
| **Rename** | Inline (F2), batch rename | ✅ inline F2 · ⬜ batch rename |
| **Clipboard** | Cut / copy / paste, paste into folder | ✅ ⌘X ⌘C ⌘V, paste into folder · ⬜ interop with Finder's pasteboard |
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
| **Progress / cancel** for long ops | KIO job tracker | ⬜ (ops are silent until done) |
| **Conflict dialog** | Overwrite / skip / rename / apply-to-all | 🟡 always auto-renames |
| **Properties dialog** | Size (recursive), permissions, dates, open-with | ⬜ |
| **Open With…** | App chooser | ⬜ |
| **Service menus / actions** | Extensible right-click actions | ⬜ (later: user scripts → menu) |
| **Archives** | Compress / extract via Ark | ⬜ zip/unzip via `ditto` |
| **Trash view** | Browse + restore | ⬜ (needs "Put Back") |
| **Tags / ratings** | Baloo | ⬜ macOS Finder tags (xattr) — a strong fit |
| **Content search** | Baloo | ⬜ Spotlight (`mdfind`) |
| **Remote locations** | sftp, smb, etc. via KIO | ⬜ mounted volumes only for now |
| **Git status overlays** | Plugin | ⬜ |
| **Per-folder view settings** | Remembered | ⬜ |
| **Session restore** | Tabs/paths reopened | ✅ tabs, folders, layout, sort, window size |
| **Customisable shortcuts** | Any action (26.04) | ⬜ |
| **Folder shelf** (Fathom original) | — | ✅ sub-folders as one scrolling row of tiles above the files |
| **Native file icons / thumbnails** | | 🟡 emoji + Quick Look thumbs |
| **Drag to/from other apps** | | ⬜ (internal drag only today) |

## Phases

### Phase 1 — Finder-replacement blockers ✅ (v0.8.0)
New folder/file, inline rename, cut/copy/paste, duplicate, undo, live filter,
type-ahead, background menu, Open Terminal Here, free space, more shortcuts.

### Phase 2 — Structure & navigation ✅ (v0.9.0)
Frontend split into ES modules (`src/js/`, no npm); Places sidebar with pins,
iCloud and volumes (eject); tabs; breadcrumb path bar with sub-folder
drop-downs; FSEvents auto-refresh; session + window-size restore. Long folders
use `content-visibility` for cheap rendering — a true **virtualised list**
moves to Phase 4 alongside the grid view, which needs the same machinery.

### Phase 3 — Operations done properly (v0.10)
- Operations in a Rust job queue with **progress, cancel**, and a jobs popover.
- **Conflict dialog**: replace / skip / keep both, apply to all.
- **Redo**; undo for Move to Bin (Finder "Put Back" via AppleScript/NSFileManager).
- **macOS pasteboard interop**: ⌘C in Fathom → ⌘V in Finder/Mail and back
  (needs a small objc2 bridge — NSPasteboard file URLs).
- **Drag in/out** of other apps (enable Tauri's native drag-drop).
- **Compress / Extract** (`ditto -c -k`, `ditto -x -k`).
- **Batch rename** (find/replace, numbering, case) with live preview.

### Phase 4 — Views & information (v0.11)
- **Virtualised list** (only on-screen rows in the DOM) for 50k-entry folders.
- **Icons/grid view** with Quick Look thumbnails + zoom (⌘+ / ⌘−).
- **Columns view** (Miller columns — Finder users will expect it).
- **Expandable folders** in details view.
- **Information panel**: metadata, PDF page one, text/code preview, folder size.
- **Properties / Get Info** (⌘I): recursive size, permissions, dates, Open With.
- Native file-type icons (NSWorkspace) instead of emoji.

### Phase 5 — Mac-native power (v0.12)
- **Finder tags** (read/write `com.apple.metadata:_kMDItemUserTags`), tag
  colours, filter by tag — Dolphin's tags/ratings, the Mac way.
- **Spotlight content search** (`mdfind -onlyin`).
- **Git status** colouring for repos.
- **User actions** (Dolphin service menus): shell snippets in a config file,
  shown in the context menu with `%f` substitution.
- Customisable keyboard shortcuts; preferences window.

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
- Other header/layout tweaks noted during v0.8–0.10 review (to be listed).
