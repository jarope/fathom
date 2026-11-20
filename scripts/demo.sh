#!/usr/bin/env bash
# Make a demo folder full of made-up files for trying Fathom, recording demos
# and taking screenshots, without showing anyone your own files.
#
#   ./scripts/demo.sh            creates ~/Fathom Demo
#   ./scripts/demo.sh <folder>   creates it somewhere else
#   ./scripts/demo.sh --reset    deletes and recreates it
#
# Everything in it is invented. It shows off: the folder shelf (lots of
# sub-folders), Grid thumbnails (generated pictures, a video if ffmpeg is
# installed), Finder tags, Git badges (a repo with modified / staged / new
# files), Spotlight content search (try "aurora" or "invoice"), archives,
# hidden files, a link, a folder of 2,000 log files for speed, and dates
# spread over the last two years so sorting and relative dates look real.
set -euo pipefail

RESET=0; DEST=""
for a in "$@"; do
  case "$a" in
    --reset) RESET=1 ;;
    -*) echo "Unknown option: $a" >&2; exit 2 ;;
    *) DEST="$a" ;;
  esac
done
DEST="${DEST:-$HOME/Fathom Demo}"
MARK=".fathom-demo"

if [[ -e "$DEST" ]]; then
  if [[ $RESET == 1 && -f "$DEST/$MARK" ]]; then
    rm -rf "$DEST"
  elif [[ $RESET == 1 ]]; then
    echo "$DEST exists but wasn't made by this script; not deleting it." >&2; exit 1
  else
    echo "$DEST already exists. Use --reset to recreate it." >&2; exit 1
  fi
fi

mkdir -p "$DEST"
touch "$DEST/$MARK"
echo "Making the Fathom demo in ${DEST}…"

python3 -I - "$DEST" <<'PY'
import os, sys, zlib, struct, random, math, time, plistlib, subprocess, zipfile, datetime

root = sys.argv[1]
random.seed(7)
NOW = time.time()
DAY = 86400

def p(*parts): return os.path.join(root, *parts)
def mkdir(*parts):
    os.makedirs(p(*parts), exist_ok=True); return p(*parts)
def write(rel, text, days_ago=None):
    path = p(rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f: f.write(text)
    age(path, days_ago); return path
def age(path, days_ago=None):
    d = days_ago if days_ago is not None else random.uniform(0, 700)
    t = NOW - d * DAY - random.uniform(0, DAY)
    os.utime(path, (t, t))

# ---------- pictures: pure-Python PNGs (gradients, waves, stripes) ----------
def png(path, w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w): raw.extend(pixel(x / w, y / h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as f: f.write(data)

def mix(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
PALETTES = [((14, 32, 54), (255, 122, 26)), ((32, 12, 64), (86, 207, 225)), ((10, 60, 40), (240, 220, 120)),
            ((70, 20, 30), (255, 180, 160)), ((20, 30, 90), (180, 120, 255)), ((5, 40, 70), (120, 230, 200))]
def scene(kind, a, b):
    if kind == "sky":
        return lambda x, y: mix(b, a, y ** 0.7) if y > 0.62 + 0.05 * math.sin(x * 9) else mix(a, b, y)
    if kind == "waves":
        return lambda x, y: mix(a, b, (math.sin(x * 12 + math.sin(y * 7) * 2) + 1) / 2 * 0.6 + y * 0.4)
    if kind == "sun":
        return lambda x, y: mix(b, a, min(1, math.hypot(x - 0.5, y - 0.45) * 2.2))
    return lambda x, y: mix(a, b, (int(x * 8) + int(y * 6)) % 2 * 0.5 + x * 0.5)

pics = mkdir("Pictures")
names = ["Aurora over the fjord", "Harbour at dusk", "Lighthouse", "Morning tide", "Northern lights",
         "Coastal path", "Rock pools", "Sea stacks", "Storm front", "Sunset sail", "Low tide", "Night sky"]
for i, n in enumerate(names):
    a, b = PALETTES[i % len(PALETTES)]
    path = os.path.join(pics, n + ".png")
    png(path, 320, 220, scene(["sky", "waves", "sun", "tiles"][i % 4], a, b))
    age(path)
# a few as JPEG / HEIC so kinds differ
for n in names[:3]:
    src = os.path.join(pics, n + ".png")
    subprocess.run(["sips", "-s", "format", "jpeg", src, "--out", src[:-4] + ".jpg"], capture_output=True)
    age(src[:-4] + ".jpg")
holiday = mkdir("Pictures", "Holiday 2025")
for i in range(18):
    a, b = PALETTES[(i * 5) % len(PALETTES)]
    path = os.path.join(holiday, f"IMG_{4100 + i}.png")
    png(path, 240, 180, scene(["sky", "waves", "sun"][i % 3], a, b)); age(path, 300 + i)
mkdir("Pictures", "Screenshots")

# ---------- documents ----------
docs = {
  "Documents/Project Aurora brief.md": "# Project Aurora\n\nA mobile app that tells you when the northern lights will be visible near you.\n\n## Goals\n- Alerts 30 minutes ahead\n- Works offline in remote areas\n- Photo tips for each night\n\n## Timeline\nBeta in spring, launch before the autumn equinox.\n",
  "Documents/Meeting notes 2026-10-14.txt": "Attendees: Sam, Priya, Alex\n\n- Aurora beta feedback is positive; battery use needs work\n- Invoice 2026-031 still unpaid, chase on Friday\n- Next review: 28 October\n",
  "Documents/Reading list.txt": "The Sea Around Us\nThe Outermost House\nWaves and Beaches\nThe Lighthouse Stevensons\n",
  "Documents/Recipes/Fish pie.md": "# Fish pie\n\nSmoked haddock, prawns, leeks, mashed potato with nutmeg. 40 minutes at 200°C.\n",
  "Documents/Recipes/Sourdough.md": "# Sourdough\n\n500 g flour, 350 g water, 100 g starter, 10 g salt. Long cold proof.\n",
  "Documents/Recipes/Lemon drizzle.md": "# Lemon drizzle\n\nThree eggs, butter, sugar, flour, two lemons.\n",
  "Documents/Letters/To the harbour master.txt": "Dear harbour master,\n\nThank you for the mooring for the summer season.\n",
}
for rel, text in docs.items(): write(rel, text)
# rich text, Word, and PDF versions via macOS's own converters
rtf = p("Documents", "Cover letter.rtf")
write("Documents/Cover letter.txt", "Dear hiring team,\n\nI build calm, fast tools for people who live in their file manager.\n\nKind regards,\nAlex Example\n")
subprocess.run(["textutil", "-convert", "rtf", p("Documents", "Cover letter.txt"), "-output", rtf], capture_output=True)
subprocess.run(["textutil", "-convert", "docx", p("Documents", "Cover letter.txt"), "-output", p("Documents", "Cover letter.docx")], capture_output=True)
os.remove(p("Documents", "Cover letter.txt"))
with open(p("Documents", "Aurora report.pdf"), "wb") as f:
    r = subprocess.run(["cupsfilter", p("Documents", "Project Aurora brief.md")], capture_output=True)
    f.write(r.stdout)
for n in ["Cover letter.rtf", "Cover letter.docx", "Aurora report.pdf"]:
    if os.path.exists(p("Documents", n)): age(p("Documents", n))

# finances: invoices + a CSV for content search
for i in range(1, 13):
    write(f"Finance/Invoices/Invoice 2026-{i:03d}.txt",
          f"INVOICE 2026-{i:03d}\nClient: Northwind Coastal Ltd (fictional)\nWork: Aurora app, sprint {i}\nAmount: £{random.randint(8, 40) * 100:,}\nDue: 30 days\n",
          days_ago=330 - i * 27)
rows = ["date,category,amount"] + [f"2026-{m:02d}-{random.randint(1, 28):02d},{random.choice(['Hosting', 'Travel', 'Hardware', 'Software'])},{random.randint(5, 900)}" for m in range(1, 12) for _ in range(6)]
write("Finance/Expenses 2026.csv", "\n".join(rows) + "\n", days_ago=3)
write("Finance/Budget.tsv", "Item\tMonthly\nHosting\t40\nDomains\t3\nCoffee\t60\n", days_ago=40)

# ---------- a git project with every badge ----------
proj = mkdir("Projects", "aurora-app")
files = {
  "README.md": "# aurora-app\n\nNorthern lights alerts. Demo project for Fathom.\n",
  "package.json": '{\n  "name": "aurora-app",\n  "version": "0.4.0",\n  "scripts": { "dev": "vite" }\n}\n',
  "src/main.ts": "import { forecast } from './forecast';\n\nforecast(64.1, -21.9).then(console.log);\n",
  "src/forecast.ts": "export async function forecast(lat: number, lon: number) {\n  return { lat, lon, kp: 5, visible: true };\n}\n",
  "src/styles.css": "body { font-family: system-ui; background: #0e2036; color: #f3efe7; }\n",
  "docs/architecture.md": "# Architecture\n\nForecast service → alert scheduler → notifications.\n",
  ".gitignore": "node_modules/\ndist/\n.env\n",
}
for rel, text in files.items(): write(os.path.join("Projects", "aurora-app", rel), text, days_ago=60)
env = dict(os.environ, GIT_AUTHOR_NAME="Demo", GIT_AUTHOR_EMAIL="demo@example.com",
           GIT_COMMITTER_NAME="Demo", GIT_COMMITTER_EMAIL="demo@example.com")
def git(*a): subprocess.run(["git", "-C", proj, *a], check=True, capture_output=True, env=env)
git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-q", "-m", "First version")
with open(os.path.join(proj, "src", "forecast.ts"), "a") as f: f.write("\nexport const KP_THRESHOLD = 4;\n")   # modified
with open(os.path.join(proj, "README.md"), "a") as f: f.write("\n## Running\n\n    npm run dev\n")
git("add", "README.md")                                                                                     # staged
write("Projects/aurora-app/src/alerts.ts", "export function alert(kp: number) { return kp >= 4; }\n", days_ago=0)  # new
write("Projects/aurora-app/.env", "API_KEY=not-a-real-key\n", days_ago=1)                                   # ignored + hidden
os.makedirs(os.path.join(proj, "node_modules", "left-pad"), exist_ok=True)
write("Projects/aurora-app/node_modules/left-pad/index.js", "module.exports = (s) => s;\n", days_ago=60)
for n in ["tide-tables", "lighthouse-site", "dotfiles"]:
    write(f"Projects/{n}/README.md", f"# {n}\n\nA demo project.\n", days_ago=random.uniform(30, 500))

# ---------- many folders for the shelf ----------
for n in ["Clients", "Design", "Downloads", "Music", "Notes", "Receipts", "Templates", "Travel", "Videos", "Work in progress"]:
    mkdir(n)
write("Clients/Northwind Coastal/Contract.txt", "Fictional contract for the Aurora app.\n")
write("Clients/Fjord Studios/Brief.md", "# Brief\n\nA calm website for a fictional studio.\n")
write("Notes/Ideas.md", "- Shelf that scrolls sideways with the wheel\n- Terminal panel (F4)\n- Tags in Grid view\n", days_ago=2)
write("Notes/Shopping.txt", "Coffee\nOat milk\nAA batteries\n", days_ago=0.2)
write("Travel/Itinerary.md", "# Tromsø\n\nDay 1: arrive, harbour walk.\nDay 2: aurora tour (fictional).\n", days_ago=120)
write("Templates/Weekly report.md", "# Weekly report\n\n## Done\n\n## Next\n\n## Blockers\n", days_ago=200)
write("Music/Playlist.m3u", "#EXTM3U\nSea Shanty.mp3\nHarbour Lights.mp3\n", days_ago=90)

# ---------- a video (only if ffmpeg is installed) ----------
vid = p("Videos", "Waves.mp4")
if subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "gradients=s=640x360:d=4:c0=0x0e2036:c1=0xff7a1a:speed=0.02",
                    "-pix_fmt", "yuv420p", vid], capture_output=True)
    if os.path.exists(vid): age(vid, 40)

# ---------- archives ----------
with zipfile.ZipFile(p("Downloads", "recipes.zip"), "w") as z:
    for n in os.listdir(p("Documents", "Recipes")): z.write(p("Documents", "Recipes", n), n)
age(p("Downloads", "recipes.zip"), 5)
subprocess.run(["tar", "-czf", p("Downloads", "tide-tables.tar.gz"), "-C", p("Projects"), "tide-tables"], capture_output=True)
age(p("Downloads", "tide-tables.tar.gz"), 9)
write("Downloads/setup-notes.txt", "Remember to back up the signing key.\n", days_ago=0.5)

# ---------- 2,000 log files for speed ----------
logs = mkdir("Logs")
for i in range(2000):
    path = os.path.join(logs, f"server-{i:04d}.log")
    with open(path, "w") as f: f.write(f"{datetime.date(2026, 1, 1) + datetime.timedelta(days=i % 300)} ok\n")
    age(path, 2000 - i)

# ---------- hidden files and a link ----------
write(".hidden-notes.txt", "You found the hidden file (⇧⌘. shows hidden files).\n", days_ago=10)
os.symlink(os.path.join("Projects", "aurora-app"), p("aurora (link)"))
write("Read me first.md", """# Welcome to the Fathom demo

Everything here is made up. Things to try:

- **Folder shelf** at the top; pinch or ⌘-scroll over it to resize, scroll sideways to move along.
- **Grid view** (⌥⌘1) in Pictures: real thumbnails; ⌘-scroll to size them.
- **Git** in Projects/aurora-app: M / S / U badges and the branch chip in the status bar.
- **Tags**: the coloured dots; click a tag in the sidebar.
- **Search** "aurora" or "invoice" (⏎ searches inside files with Spotlight).
- **Logs** has 2,000 files; scroll, sort and filter stay instant.
- **Twin panes** (⌘\\\\) and drag between them; **Get Info** (⌘I); **F11** information panel.
- **Archives** in Downloads: right-click → Extract.
- **Hidden files**: ⇧⌘. shows .hidden-notes.txt.
""", days_ago=0)

# ---------- Finder tags ----------
COLOURS = {"Red": 6, "Orange": 7, "Yellow": 5, "Green": 2, "Blue": 4, "Purple": 3, "Grey": 1}
def tag(rel, *names):
    tags = [f"{n}\n{COLOURS[n]}" if n in COLOURS else n for n in names]
    data = plistlib.dumps(tags, fmt=plistlib.FMT_BINARY).hex()
    subprocess.run(["xattr", "-wx", "com.apple.metadata:_kMDItemUserTags", data, p(rel)], capture_output=True)
tag("Finance/Invoices/Invoice 2026-011.txt", "Red")
tag("Finance/Invoices/Invoice 2026-012.txt", "Red")
tag("Documents/Project Aurora brief.md", "Blue", "Work")
tag("Projects/aurora-app", "Blue", "Work")
tag("Pictures/Aurora over the fjord.png", "Green")
tag("Pictures/Northern lights.png", "Green", "Purple")
tag("Notes/Ideas.md", "Orange")
tag("Travel", "Yellow")
tag("Clients", "Work")

# Folder dates last (writing inside a folder updates its date).
for d, _, _ in sorted(os.walk(root), key=lambda w: -w[0].count(os.sep)):
    if "node_modules" in d or os.sep + ".git" in d: continue
    if d != root: age(d, random.uniform(0, 400))
age(p("Notes"), 0.2); age(p("Projects"), 0); age(p("Pictures"), 3)
PY

# Let Spotlight index it now so content search works straight away.
mdimport "$DEST" >/dev/null 2>&1 || true
echo "Done. Open \"$DEST\" in Fathom and start with \"Read me first.md\"."
