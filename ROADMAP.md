# Fathom roadmap — a Dolphin-class file manager for macOS

Goal: a native macOS file manager that does what KDE **Dolphin** does well, so
Finder becomes optional — and that is polished enough to release publicly.

Status key: ✅ done · 🟡 partial · ⬜ not started

## Gap analysis vs Dolphin

| Area | Dolphin | Fathom |
| --- | --- | --- |
| **Split view** (F3) | Two panes, independent | ✅ twin pane (⌘\\) |
| **Create new** | Folder (F10), file from templates | ✅ folder (⇧⌘N / F10 / ＋), text file (⌥⌘N), New from Template (~/Templates) |
| **Rename** | Inline (F2), batch rename | ✅ inline F2 · ✅ batch rename with preview |
| **Clipboard** | Cut / copy / paste, paste into folder | ✅ ⌘X ⌘C ⌘V, paste into folder, Finder pasteboard both ways, ⌥⌘V move |
| **Duplicate** | Ctrl+D | ✅ ⌘D |
| **Undo / redo** | Ctrl+Z for file operations | ✅ undo / redo of rename, move, copy, create and Move to Bin (Put Back) |
| **Filter bar** (Ctrl+I) | Live filter of current folder | ✅ search box filters live; ⏎ searches recursively |
| **Type-ahead** | Jump to name as you type | ✅ |
| **Free space** in status bar | ✅ | ✅ |
| **Open Terminal here** / Terminal panel (F4) | Embedded panel | ✅ opens Terminal.app (⌥⌘T) · ✅ F4 panel (xterm.js + pty), follows the folder both ways |
| **Background context menu** | New, paste, terminal, view options | ✅ |
| **Tabs** (Ctrl+T) | Tabs per window, each optionally split | ✅ ⌘T, each tab single/twin, drop onto tabs |
| **Places panel** | Home, Desktop, Downloads, devices, network, bookmarks, recent | ✅ favourites, pins, iCloud, volumes + eject, Recent (⇧⌘O), network shares, Bin |
| **Breadcrumb location bar** | Clickable segments with sub-folder drop-downs; Ctrl+L to edit | ✅ segments, › drop-downs, ⌘L to type, drop targets |
| **View modes** | Icons, Compact, Details, Columns (back in 2026) | ✅ Details (expandable), Grid, Columns |
| **Zoom** | Ctrl+wheel / slider | ✅ window zoom (⌘+ / ⌘−, scroll over Aa), grid and shelf icon size (pinch / ⌘-scroll, slider) |
| **Expandable folders** in details view | Tree in list | ✅ |
| **Folders panel** | Tree sidebar | ✅ F7: sidebar Places ⇄ Folders tree, follows the current folder, takes drops |
| **Information panel** | Preview + metadata of selection | ✅ F11 panel: Quick Look picture, metadata, folder size |
| **Auto-refresh** | Watches folders (KDirWatch) | ✅ FSEvents via `notify` |
| **Progress / cancel** for long ops | KIO job tracker | ✅ job cards: bar, speed, ETA, cancel |
| **Conflict dialog** | Overwrite / skip / rename / apply-to-all | ✅ keep both / replace (→ Bin) / skip / merge, apply to all |
| **Properties dialog** | Size (recursive), permissions, dates, open-with | ✅ Get Info (⌘I) |
| **Open With…** | App chooser | ✅ Open With ▸ (default app first) |
| **Service menus / actions** | Extensible right-click actions | ✅ actions.json + Preferences editor, background or terminal |
| **Archives** | Compress / extract via Ark | ✅ compress (zip) / extract (zip, tar, 7z, rar…) |
| **Trash view** | Browse + restore | ✅ Bin in the sidebar: browse, Put Back (Fathom's and Finder's records), Delete Immediately, Empty Bin |
| **Tags / ratings** | Baloo | ✅ Finder tags: dots, menu, ⌃⌘1–7, sidebar, drop-to-tag |
| **Content search** | Baloo | ✅ Spotlight: contents / names, here or whole Mac, streamed; saved searches |
| **Remote locations** | sftp, smb, etc. via KIO | ✅ Connect to Server (⌘K): SMB / AFP / NFS / WebDAV mounted by macOS · ✅ sftp built in (see SFTP below) |
| **Git status overlays** | Plugin | ✅ badges, folder roll-up, branch ↑↓ chip, Commit… / Push |
| **Per-folder view settings** | Remembered | ✅ view mode + sort per folder (since v0.19) |
| **Session restore** | Tabs/paths reopened | ✅ tabs, folders, layout, sort, window size |
| **Customisable shortcuts** | Any action (26.04) | ✅ shortcut editor with clash warnings |
| **Folder shelf** (Fathom original) | — | ✅ sub-folders as one scrolling row of tiles above the files |
| **Native file icons / thumbnails** | | ✅ Finder icons in lists, Quick Look thumbnails in grid |
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

### Phase 4 — Mac-native power ✅ (v0.14.0–v0.17.0)
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

**v0.16 — Git** ✅
- Rows coloured/badged: modified, new, staged, conflicted; ignored dimmed;
  folders roll up their contents' status; branch + ahead/behind in the status bar.
- Refreshes on file changes (FSEvents watcher already in place).
- **Simple commit & push**: right-click → *Commit…* (pick files, message,
  commit) and *Push* to the tracking remote — progress card, errors shown in
  full; anything fancier stays in your git tools.

**v0.17 — User actions, Preferences, Shortcuts** ✅
- **User actions** (Dolphin service menus): right-click entries defined in
  `~/.config/fathom/actions.json` **and** editable in Preferences (same file).
  `%f` file, `%F` all selected, `%d` current folder; filter by type / folders /
  multi; run in background (progress card) or in Terminal. Ships with examples.
- **Preferences window**: start folder, defaults (hidden, shelf), date format,
  terminal app (Terminal / iTerm / Ghostty / Warp), session restore.
- **Shortcut editor**: rebind any action, clash warnings.

### Visual redesign ✅ (v0.18.0)
The `DESIGN.md` spec, done before Phase 5 so the new views are built in the
final look once: colour tokens for light/dark in one theme file, accent from
macOS or Orange/Indigo/Teal/Graphite, real window vibrancy behind the
sidebar (`macOSPrivateApi` — rules out the Mac App Store), glass popovers,
system font + bundled JetBrains Mono, capsule controls, 34pt rows, file-kind
glyphs and tints, Reduce Transparency / Increase Contrast, glass opacity.

### Phase 5 — Views & information ✅ (v0.19.0–v0.24.0)
**v0.19 — Display engine + Details view** ✅
- **Display engine**: only on-screen rows exist (virtual window over the
  pane's entries) — 50k-entry folders stay smooth; selection, rename,
  type-ahead, drag & drop, menus and git badges unchanged.
- **Details view**: folders expand in place (disclosure / → ←, filter keeps
  parents of matches, open sub-folders auto-refresh and get git badges);
  choosable columns (Kind, Created, Date Added, Extension, Permissions) via
  header right-click, resizable by dragging; per-folder sort memory.
- App bundles and other packages act as files (open, don't browse).

**v0.20 — Grid view** ✅
- **Grid view** (⌥⌘1 / ⌥⌘2, header buttons): Quick Look thumbnails from
  QLThumbnailGenerator (no process per file), Finder icons for the rest;
  virtualized like Details; icon-size slider; ⌘+ / ⌘− size icons in grid like Finder (window zoom also
  on ⌥⌘+ / ⌥⌘−); per-folder view.
- **Rubber-band selection** in both views (auto-scrolls; ⌘/⇧ add).
- Folder menu gains **View ▸** and **Sort By ▸** (the grid has no header).
- Fixed: ↑ in Details could leave the row under the column header.
- v0.20.1: column dividers resize the column on their left (drag right =
  wider, Name included; sideways scroll when too wide). **Copy to ▸ / Move
  to ▸** list the other pane, recent destinations and Places, and "Other
  Folder…" opens a folder browser inside Fathom instead of the macOS panel.
  Drag & drop fixed: dragging *out* of Fathom had never worked on macOS 27
  (drags were drawn but no app was offered them). Drags inside the window are
  now handled by the page (ghost label, ⌥ copy, Esc); leaving the window hands
  over to a macOS drag started from the original mouse-down.

**v0.21 — Columns view** ✅
- **Columns view** (⌥⌘3): ancestors with the path highlighted, the current
  folder (all selection / rename / menus / drag & drop / git work as usual),
  and a preview column — a folder's contents or a file's picture and facts.
  → / ← move in and out; clicking another column works there; the first
  column stays put while you browse inside it (Finder). Every column is
  virtualized. Searches fall back to Details.
- Fixed: renaming a file scrolled out of view did nothing.

**v0.22 — Get Info** ✅
- **Get Info** (⌘I, both right-click menus): kind, size (folders counted in
  the background — cancelled when you close it — hard links once), where,
  dates incl. last opened, Spotlight metadata (dimensions, duration, codecs,
  camera/exposure, location, pages, version, where from), tags (toggle / add),
  default app, permissions (owner / group / everyone checkboxes → chmod).
  Several items: total size, kinds, shared tags.

**v0.23 — Finder icons in lists** ✅
- Details and Columns rows (and the drag ghost) show real NSWorkspace icons:
  files cached by type, folders / apps / packages / links by path (special
  and custom folder icons), one batched call per paint, identical images
  shared. The kind glyph shows until the icon lands. Preferences toggle.

**v0.24 — Information panel** ✅
- **Information panel** (F11 / ⌘P) replaces the preview dock: a resizable
  panel on the right that follows the active pane — Quick Look picture (any
  file type; click for Quick Look), kind, size, dates, tags, Spotlight facts,
  folder size on demand; several items: count, kinds, total; nothing
  selected: the folder. *Get Info…* button.
- Fixed: pictures outside the grid (Columns preview, Get Info) could stay as
  the kind symbol because the thumbnail was asked for before it was on screen.
- **Open Location** (⇧⌘R) for items outside the folder on screen (search,
  tags, expanded rows): go to the item's folder and select it; ⌥ in the menu
  or ⌥⇧⌘R opens it in the other pane (switching to twin). Menus now swap
  items while ⌥ is held, like macOS. Reveal in Finder moved to the bottom.
- Fixed: a Columns row could be drawn for an item that had just gone.

Phase 5 complete.

**v0.25 — Scroll-wheel controls**
- Scroll over the zoom (Aa) button to zoom, like a Linux tray volume icon:
  one mouse-wheel click = one step, trackpads step every ~30 px, and a
  gesture keeps zooming even when the button moves out from under the
  pointer; the list gets its scroll back as soon as the gesture pauses.
- Scroll over the grid's icon-size slider, or pinch / ⌘-scroll over the
  grid, to size just the icons (the window stays as it is).
- **Folder shelf**: stays fixed at the top while the files scroll under it;
  pinch / ⌘-scroll over it sizes just its tiles (32–96 pt, remembered);
  sideways scrolling (trackpad, a mouse's side wheel such as the MX Master's
  thumb wheel, or ⇧-scroll) moves the shelf and never the list.
- All wheel handling lives in `wheel.js`.

**v0.26 — Themes, recent searches**
- **Colour themes**: one for light mode, one for dark; Solarized, Nord,
  Dracula, Gruvbox, Catppuccin built in; import base16 (YAML / JSON), VS Code
  colour themes or Fathom JSON (choose a file or paste). Missing colours are
  worked out from background + text; the theme's accent is used unless you
  pick one. Painted before settings load, so no flash at launch.
- **Custom accent colour** (any colour, via the macOS colour picker).
- **Recent searches**: the last 10 under the search box (with their mode);
  ↑ ↓ ⏎, × to forget, Clear; matching ones while typing.
- Fixed: rows could show in a thin gap between the pinned shelf and the
  column header (they're now one pinned block).

### Phase 6 — Public release (v1.0)
- **Name: keeping "Fathom"** ✅ — Finder → Fathom: it goes deeper into the
  system (Spotlight-powered search), and its features come from a creature of
  the sea (Dolphin). Other Fathoms (analytics, meeting notes, VST plugins, a
  Jellyfin media client) are different categories; no file manager of that
  name found (Nov 2026). Before release: check the Mac App Store listing name
  is free and a quick trademark search in the software class.
- **Licence: GPL-3.0-or-later** ✅ — free and open source, matching the
  Dolphin heritage; improvements to Fathom stay open. `LICENSE` in the repo;
  every Rust dependency is GPL-compatible (MIT / Apache / BSD / MPL-2.0 /
  Zlib / Unicode); JetBrains Mono is SIL OFL (`src/fonts/JetBrainsMono-OFL.txt`).
- **Release script** ✅ `scripts/release.sh` — universal (Apple Silicon +
  Intel) .app / .dmg, signed update bundle, `latest.json`, sha256; checks the
  three version numbers and the CHANGELOG agree; `--publish` tags and creates
  the GitHub release with `gh`. Ad-hoc signed by design: no Apple Developer
  account / notarisation (the audience is developers; the README explains
  the one-time Open Anyway). The script would still sign + notarise if
  `APPLE_SIGNING_IDENTITY` etc. were ever set.
- **Auto-update** ✅ tauri-plugin-updater + GitHub Releases: daily quiet
  check, update card (Install & Relaunch / Skip This Version), Preferences
  toggle + Check Now; off in dev builds. Key: `~/.tauri/fathom-updater.key`,
  password in the login Keychain (`fathom-updater-key`) — back the key up.
- **Homebrew cask** ✅ `packaging/homebrew/fathom.rb` for the
  `jarope/homebrew-fathom` tap (unsigned apps can't go in homebrew-cask).
- **CHANGELOG.md** ✅ — each version's section is the release notes and the
  update card text.
- **Full Disk Access guidance** ✅ — protected folders explain themselves and
  open the right Settings page; permission prompts say why (Info.plist).
- **Accessibility pass** ✅ (first round) — file lists are VoiceOver lists
  (name, kind, selected, position; the cursor is followed), menus / dialogs /
  status bar marked up, sidebar places and tabs reachable with Tab and
  opened with ⏎ / Space. Still to do: full keyboard focus order through the
  toolbar, and a real VoiceOver walk-through.
- Minimum macOS 11 (Big Sur).
- **Released** ✅ github.com/jarope/fathom, first releases 0.27.2 / 0.27.3;
  in-app update verified end to end (0.27.2 → 0.27.3).
- **Homebrew** ✅ tap `jarope/homebrew-fathom` (Homebrew 7 install steps;
  `brew trust` once); `release.sh --publish` updates it.
- **Demo folder** ✅ `scripts/demo.sh` → ~/Fathom Demo (made-up files).
- **Still to do before v1.0**: screenshots + a landing page (GitHub Pages).
- **Self-signed code-signing certificate** ⬜ — no Apple Developer account
  needed: a "Code Signing" certificate made in Keychain Access, used via
  `APPLE_SIGNING_IDENTITY` in release.sh. Gives every release the same
  signing identity, so Full Disk Access / Automation grants survive updates
  (ad-hoc signatures change per build). Doesn't change first-install
  Gatekeeper ("Open Anyway" still needed). Back up the certificate + key.
  No Developer ID / notarisation — decided against.

## SFTP — built into Fathom (v0.35; polish in D)
macOS can't mount sftp, so Fathom does it itself. Decided Nov 2026:
- **Transport**: `/usr/bin/ssh` does the connection (one ControlMaster per
  server, `ssh -S … -s sftp` channels), so ~/.ssh/config, agent, ProxyJump,
  hardware keys and known_hosts behave exactly as in Terminal. Fathom has its
  own small blocking SFTP v3 client over ssh's stdio (`src-tauri/src/remote/`),
  tested against `/usr/libexec/sftp-server`. Prompts via `SSH_ASKPASS` → our
  own binary (`--askpass`) → a Fathom dialog; optional Keychain passwords.
  A changed host key is always refused.
- **Paths**: `sftp://<alias or user@host:port>/<abs path>`; `src/js/loc.js`
  holds parent/join/crumbs/caps so every path list keeps working.
- **Your choices**: sidebar shows saved servers only (+ "Add from ssh
  config…"); Replace onto a server allowed, worded "Replace (deletes the
  server's copy)", old copy removed only after the upload succeeds; saved
  remote files upload silently (asked only if the server copy changed);
  restored server tabs reconnect silently or show "Disconnected — Reconnect".
- Off on servers: Quick Look / thumbnails (until D), Spotlight, git, tags,
  Usage, terminal follow, Bin (delete is permanent, confirmed).

Phases (each shippable):
- ✅ **A — connect & browse** (read-only): client, transport, askpass, config
  hosts, Servers in the sidebar, ⌘K `sftp://` / `user@host`, all views,
  crumbs, filter, polling refresh (3 s mtime / 30 s full), quiet restore with
  a Reconnect placeholder. Tested in cargo (client vs sftp-server, stand-in
  ssh, opt-in e2e: `FATHOM_SSH=<wrapper> FATHOM_E2E_CONN=<host> cargo test
  e2e -- --ignored`) and in the app against a private sshd on 127.0.0.1:2222
  (runs as you, key-only, `UsePAM no`; Remote Login stays off).
- ✅ **B — copy / move both ways** through the job engine (progress, cancel,
  conflicts), F5/F6, drag between panes; uploads go to `.fathom-part` first,
  server-side Replace via `.fathom-new` then swap (`remote/xfer.rs`). Tested
  in cargo (vs sftp-server, and e2e through real ssh) and in the app.
- ✅ **C — rename, delete, new folder, open & save back** (`remote/files.rs`):
  saves upload via `.fathom-part` + posix-rename; a server copy changed since
  opening asks (replace / save as copy / don't upload). Tested in cargo e2e
  through real ssh, and in the app. Batch rename, duplicate,
  compress / extract stay Mac-only for now.
- ⬜ **D — polish**: streamed huge listings, Quick Look via cached download,
  chmod, Open SSH Session Here, server→server, resume, remote name search.

## Polish backlog (after feature-complete, before daily-driver)
Deferred on purpose — features first, then a polish pass.
- ✅ Terminal panel: Warp-style command blocks via shell integration (OSC 133)
  — done in v0.34 for zsh (`src-tauri/shell`, `termblocks.js`). bash / fish
  integration still to do.
- DESIGN.md kind tints Document / Video / Code are ~2.9:1 on dark content
  (spec only promises ≥3:1 on light); consider lighter dark-mode variants.
- Folder shelf: optional mouse-wheel → sideways scroll while hovering the shelf.
- Drag cursor always shows the "+" (copy) badge over Fathom, even when the
  drop will move — Tauri's drop handler always answers "copy" to AppKit.
- Other header/layout tweaks noted during v0.8–0.10 review (to be listed).
