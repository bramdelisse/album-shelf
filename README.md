# album-shelf

Your saved albums, plotted on two axes you label by hand. Astro, static, deployed to Cloudflare Pages.

The question this answers is *what do I want to hear right now*, and it answers it by
being looked at rather than operated. There are no filters to set. Two continuous axes
make a plane, every album sits somewhere on it, and each one is a colour you chose.
You point at a region — low energy, background — and the albums are there.

## The three labels

| Label | Range | What it is |
| --- | --- | --- |
| **energy** | 0–100 | From *brengt je in slaap* to *brengt je naar de maan*. |
| **attention** | 0–100 | From *je vergeet dat het aanstaat* up to *eist alle aandacht*. |
| **colour** | any hex | How it feels. No palette, no list — a free choice, suggested from the cover. |
| **gem** | `x` or blank | One of the twenty-odd albums that really matter. |
| **review** | one sentence | Optional. Shown under the album, the way a note under a record sleeve reads. |
| **labelled** | date | When the judgement was last made. |

A gem is deliberately invisible on the plane — the overview stays about colour and
position. It shows only once you open an album: a sunflower diamond stuck on the corner
of the cover. `labelled` exists because a judgement from a year ago is weaker evidence
than one from today, and eventually you will want to revisit the oldest ones.

The axis was called `place` in the first version. Files using that header are still read
correctly and get rewritten with `attention` on the next save.

All three are set by hand, on purpose. Spotify's `audio-features` endpoint was
deprecated in November 2024 and returns 403 to any app registered since, so deriving
energy from the API is not available — but that is not why this is manual. A shelf
labelled by a machine tells you what a machine thinks, and then it is not your shelf.

An album needs all three labels before it appears. Unlabelled albums are counted, not shown.

## How the data moves

Two files, two owners, joined on the Spotify album ID.

```
Spotify  --npm run import-->  data/albums.json      machine-owned: artist, title, year, cover, link
                        \
                         `-> <vault>/albums.md      human-owned: energy, attention, colour
                                    |
                             npm run sync
                                    |
                                    v
                             src/data/labels.json   committed, so Cloudflare can build
```

`data/albums.json` is regenerated on every import. `albums.md` is only ever *added to* —
the import writes new albums as blank rows and never touches a label you typed. Albums
you unsave move to a second table at the bottom of that file instead of disappearing, so
un-saving an album by accident cannot cost you its labels.

The label table lives in an Obsidian vault rather than this repo because that is where
the labelling happens. `ALBUM_LABELS` in `.env` points at it. The same three-state rule
as the website repo applies:

| `ALBUM_LABELS` | What happens | Where |
| --- | --- | --- |
| set, file exists | reads the vault directly — nothing stale | laptop |
| not set | uses the committed `src/data/labels.json` | Cloudflare |
| set, file missing | **sync fails and the build stops** | a typo in `.env` |

The third row is deliberate. A mistyped path that silently fell back would build
yesterday's shelf and look like a success.

## Setup

**1. A Spotify app.** Create one at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
Set the redirect URI to exactly:

```
http://127.0.0.1:8888/callback
```

Not `localhost` — Spotify stopped accepting that hostname and the string must match
character for character. Two things worth knowing before you start: a development-mode
app is limited to five users, which is plenty for a personal shelf, and as of February
2026 the account registering the app needs Spotify Premium.

**2. Configure and install.**

```powershell
git clone https://github.com/<you>/album-shelf.git
cd album-shelf
npm install
copy .env.example .env      # then fill in SPOTIFY_CLIENT_ID and ALBUM_LABELS
```

**3. Import, label, look.**

```powershell
npm run import   # browser login the first time, then writes albums.md
npm run colours  # reads a suggested colour off every cover
npm run label    # http://127.0.0.1:8899 — one album at a time
npm run dev      # http://localhost:4321
```

## Labelling

`npm run label` opens a page that shows one album at a time: cover, a number box
and slider for each axis, a colour picker, and a small live copy of the plane so you
can see where the album lands among the ones already placed. That preview is the point
— these are relative judgements, and placing an album against an empty grid is guessing.

The colour arrives pre-filled with the dominant colour of the album cover, because in
practice that is what you pick nearly every time — so the job becomes reviewing a
suggestion rather than making a decision. *uit de hoes* puts it back if you have
changed it and want the original again. Run `npm run colours` once to read those
colours off the covers; `npm run import` does it for new albums automatically.

The colour is chosen by hue, not by counting RGB values. A gradient sky spans dozens of
RGB values but only a couple of hues, so counting RGB let any flat block — a jacket, a
shadow — win on count alone while the thing you actually see lost. Pixels are weighted
by brightness (sub-linearly, so a large dim area still competes with a small bright one)
and by saturation, and near-black is ignored outright. Covers that really are black and
white fall back to their grey. Each result is stamped with the algorithm version, so
improving the picking makes `npm run colours` re-read covers it has already seen; use
`npm run colours -- --force` to redo them all regardless.

`Enter` saves and moves on, `Esc` skips. Each save writes to the label table in the
vault immediately, so stopping halfway loses nothing, and it rewrites
`src/data/labels.json` too — which means a `npm run dev` running in another terminal
shows the new dot on the real shelf within a second.

Close `albums.md` in Obsidian while labelling, so the editor and the script are not
both writing the same file.

By default it queues only unlabelled albums. Tick *ook al gelabelde albums tonen* to
walk through everything and revise.

### Schikken

The second tab is for the second pass. It shows the whole plane and you drag albums
around; each drop saves immediately.

Dots are sized and darkened by how long ago they were judged, so the plane itself shows
what is stale — and moving an album re-dates it, which makes it recede. The first pass
is guesswork against an empty grid; this is where the positions actually become right,
because here you are placing an album against its neighbours rather than against an
abstract 0–100 scale. Clicking a dot without dragging just selects it, and *Open in
labelen* jumps to that album in the first tab to change its colour or gem.

**Two kinds of skipping.** *Overslaan* (`Esc`) passes over an album for now; it comes
back next session. *Niet labelen* takes it out for good: the row moves to a separate
table at the bottom of `albums.md` and imports never put it back. Use that for albums
you do not actually listen to. The page then lists them with a link, so you can unsave
them in Spotify — which is what makes them disappear from the catalogue on the next
import. To undo, delete the row from that table by hand.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run import` | Pulls saved albums from Spotify, rewrites `data/albums.json`, adds new blank rows to the label table |
| `npm run colours` | Reads the dominant colour off each cover into `data/albums.json`; skips covers it already knows. `-- --force` redoes them all |
| `npm run label` | Local labelling page on `:8899`, writes straight to the vault |
| `npm run sync` | Reads the label table into `src/data/labels.json` |
| `npm run dev` | `sync`, then dev server on `:4321` |
| `npm run build` | `sync` + Astro build → `dist/` |
| `npm run preview` | Serves `dist/` locally |

`sync` runs automatically before `dev` and `build`. A row with a malformed value is
skipped with a message naming the album, rather than breaking the build.

## Deploying

Cloudflare Pages, connected to this repo. Build command `npm run build`, output directory
`dist`, Node 22 (read from `.nvmrc`).

Do **not** set `ALBUM_LABELS` in the Cloudflare environment — the vault does not exist
there, and its absence is what makes the build fall back to `src/data/labels.json`. So
publishing new labels means committing that file:

```powershell
npm run build     # reads the vault, rewrites src/data/labels.json
git add -A
git commit -m "labels"
git push          # Cloudflare builds and deploys
```

`data/albums.json` is committed too — it holds the titles, cover URLs and cover colours
the page needs, and none of it is secret. `.env` and `.spotify-token.json` are ignored;
check that before the first push.

**Custom domain.** In the Pages project, *Custom domains* → add the subdomain. If the
zone is on Cloudflare the DNS record is created for you. If it is not — bramdelisse.me
is still on Hostinger at the time of writing — Cloudflare gives you a target and you add
the record at your registrar yourself:

```
CNAME   albums   album-shelf.pages.dev
```

The certificate is issued once the record resolves, which is usually minutes.

**One thing that cannot be changed later:** a Pages project is either Git-connected or
Direct Upload, and it cannot be switched. `npx wrangler pages deploy dist` is quicker for
a first look, but it makes the project Direct Upload for good. Connecting the repo is
worth the few extra clicks, because after that publishing is just `git push`.

## What is not here

Cover colours are computed locally with sharp, which Astro already installs.

No database, no API at runtime, no accounts, no player. The published site is static
files. Spotify is contacted once, locally, by a script you run — never by the page, which
is why no token exists anywhere near the deployment.

## Credentials

`.env` and `.spotify-token.json` are gitignored. The auth flow uses PKCE, so there is no
client secret to leak in the first place. If you fork this, check both files are still
ignored before your first push.

## Licence

MIT.
