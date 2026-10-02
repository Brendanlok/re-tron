# Re-Tron — launch copy

DRAFT, written 30 Sep by the scheduled session for Lok to edit. **Nothing here has been
posted.** Announcing the game is Lok's call; this folder only has the pieces ready.

Live link: https://brendanlok.github.io/re-tron/

Saturday's regression list runs as one command from the repo root: `python preflight.py`.
Sixteen checks, every one of them something that has gone stale silently before: the live
link serves the page in this folder, the itch zip is that same page, THE PAGE OPENS THAT
SAME ARENA, the preview image and every icon still resolve, the arena answers the menu's
two questions, the DEPLOYED worker is the server in this folder (it reads the last deploy
out of wrangler), and the arena actually SEATS A BIKE AND RIDES IT. That last one matters
most on Sunday morning: the two cheap paths the menu uses never touch the tick, so a
referee that throws on every tick still answers both with a healthy 200 - every other
check here would pass over an arena nobody can play. It rides for six tenths of a second
and never asks for the blade, so it lays no wall, can own no knockout, scores 0, and the
referee writes nothing down: unlike `server/test-arena.mjs`, this one is safe to point at
the live arena and does so by default. Run it on its own with
`node server/live-pulse.mjs`.

The third is the only one that asks the page itself. Every other check here talks to the
arena by the address written at the top of `preflight.py`, so none of them would notice a
page aimed somewhere else: the link would serve, the zip would match, the arena would answer
and ride, and the whole list would go green over a game that loads perfectly and then says
"could not reach the arena" to every player. That line in `index.html` has been wrong in
exactly this way once already - it used to name github.io as the one host that gets the real
server, which left the itch build and anything opened from disk quietly talking to localhost.
It reads the live branch out of the page and compares it, so a typo, another rename, or a dev
session that swapped the two branches and committed it all fail loudly. Asserted all three
ways with `python preflight.py --self-check`, which runs offline before any network call.

The fifteenth watches the BILL rather than the players: it asks the deployed arena whether
it stops ticking once the last rider hangs up. The Durable Object is charged for wall-clock
time whenever it is awake and the arena ticks ten times a second, so one that keeps running
on an empty board spends the free allowance all night — and nothing visible says so, because
`/count` answers `{"on":0}` either way. It rides, reads the clock, hangs up, waits twelve
seconds with nobody connected, and rides again: a clock back near zero means the arena shut
down. Measured live on 2 Oct and healthy. It stands down by itself the moment anyone is
riding — a busy arena is *supposed* to keep ticking — so it will not cry wolf on the one
morning the link gets a crowd, and it cannot dirty the board either: each bike is let go on
its first tick and never asks for the blade, so it scores 0. It adds about 25s to the run,
nearly all of it the two deliberate waits. On its own: `node server/idle-stop.mjs`.
One honest limit: its failing branch could not be tested end to end, because a local
`wrangler dev` cannot reproduce a runaway clock (miniflare suspends the isolate between
requests, and a scratch copy with `stop()` neutered still read as healthy). The verdict
logic is asserted both ways instead — `node server/idle-stop.mjs --self-check`. Green here
means the live arena's clock did reset: strong evidence, not a proof.

The sixteenth is the only one aimed at a job rather than a fault, and it is YOURS: the
all-time board still carries four runs nobody played (SDF 29, TEST 21, LOK 7, TWO 1), so
the board a first visitor meets says the record is twenty seconds. Wipe it before you
announce. The key goes in the URL, not a header, so in PowerShell it is one line:

    irm -Method POST "https://re-tron.chanlokk97.workers.dev/board?wipe=1&key=YOURADMINKEY"

That clears Today and All time together - they are the same runs table read two ways, so
there is nothing to clear separately. The reply lists whatever is left, so an empty list
is your confirmation and there is no second command to run. Swap `wipe=1` for `name=SDF`
to drop one rider instead. Until Sunday the check prints a TODO line and leaves the
run green; from Sunday it FAILS outright, so the list cannot go green on launch morning
with the junk still up. It matches all four fields rather than the name, because LOK is a
name a real player may ride under. Both halves are asserted: `python preflight.py
--self-check`.

Green means go - and no TODO line under it.

## Assets in this folder

| File | What it is |
|---|---|
| `re-tron.zip` | The game for itch's upload box: index.html, manifest, icons, favicon, og.png. No build step, no server files — the arena is a Cloudflare Worker the page talks to over the network. **Repack it whenever index.html changes**, and always after the Friday freeze, with the command under “Repacking the zip” below — plain `git archive` is not enough. |
| `re-tron-run.gif` | 6s loop, 460x690, 0.9 MB. The whole arena from above, six bikes, one of them cyan. Bikes ride blank, switch the blade on, lay ribbons, box each other in, and the walls fade. Recorded from the game's own attract loop, not a mock-up. |
| `itch-cover.png` | 1260x1000 itch cover (2x itch's 630x500, same ratio) in the Breakin/Snaked layout: the arena live behind, RE-TRON and the tagline on a dark band at the foot. |
| `shot-0-menu.png` | The menu at phone width (1000x2080, 2x). Under itch's 2160px limit. |
| `shot-1-arena-phone.png` | Mid-run on a phone: six bikes, your ribbon curling back under you, one rider heading straight at it. Shows the arrow pad and the BLADE button. |
| `shot-2-knockout-phone.png` | The moment a rival rides into your wall and derezzes into tumbling cubes. Strongest single image. |
| `shot-3-arena-wide.png` | 1280x720 on a computer, keyboard HUD. Good for a page header. |

## Repacking the zip

```
git -C <tron folder> -c core.autocrlf=false archive --format=zip -o press/re-tron.zip HEAD index.html manifest.json favicon.svg icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png og.png
```

`-c core.autocrlf=false` is not optional on Windows. Without it `git archive` rewrites every text
file in the zip to Windows line endings, so index.html came out 953 bytes bigger than the one that
is live — the same page, but no longer the same bytes. itch runs it fine either way; the damage is
to the check below, which is the only thing standing between a stale zip and a page two fixes behind
the link while both halves talk to the same arena. A check that always reports a difference is a
check nobody can read, and the zip went stale twice in one day on 1 Oct without anyone noticing.

Then confirm the zip is the page that is live — this must print True twice:

```
python -c "import zipfile,urllib.request;z=zipfile.ZipFile('press/re-tron.zip');l=urllib.request.urlopen('https://brendanlok.github.io/re-tron/index.html').read();print(z.read('index.html')==open('index.html','rb').read());print(z.read('index.html')==l)"
```

First line: the zip matches the repo. Second: the repo matches the live page. Both True means the
file in itch's upload box and the file behind the link are the same game. Last run 2 Oct, both True
(`python preflight.py` checks the same two things as its first and second lines, so a green run is
this command already done).

Every image is rendered by the real game code driven frame by frame, not drawn by hand.
The riders and scores in them are staged; no real player's run is shown.

## One-liner

> Tron light cycles, online, in one shared arena you can join any time — except your bike
> leaves nothing behind until you switch on the blade.

## Title options

- Re-Tron — Tron light cycles, except you only leave a wall when you choose to
- I made a Tron where the trail is a weapon you have to spend, not something you drag around
- Re-Tron: one shared arena, join any time, and your own wall kills you too

## The pitch, short

Classic Tron punishes you for existing: the trail is always on, so the game is mostly about
not painting yourself into a corner. Re-Tron takes the trail off and hands it back as a
button. Ride clean as long as you like. Switch on the blade and you lay a wall of light that
knocks out anyone who rides into it — including you. You get about three seconds of it per
charge and six to get it back, so the whole game is picking the moment.

Everyone is in the same arena. There are no rounds and no lobby: you join, you ride, and when
you are knocked out you ride straight back in. Bots keep the arena at six bikes so it is never
empty, and they step aside as real people arrive.

## r/WebGames

**Title:** Re-Tron — Tron light cycles online, except your bike leaves no trail until you switch on the blade

Browser game, no sign-in, no ads, works on phones.

It's Tron with the trail turned into a resource. Normally your wall is always on and the game
is about not trapping yourself. Here you leave nothing behind until you press the blade, and
then you lay a wall of light that takes out anyone who rides into it — you included. About
three seconds of blade per charge, six seconds to recharge, so you spend the whole run
deciding when it's worth it.

One shared arena, slither.io style: join any time, no rounds, no waiting. Walls fade after
eight seconds and vanish the moment their owner is knocked out, so the arena never silts up.
Score is one point per second alive plus ten a knockout, and the board keeps Today and
All time.

Arrow keys or WASD to steer, space for the blade. On a phone there's an arrow pad and a
BLADE button.

https://brendanlok.github.io/re-tron/

It's the third one of these I've made — the first two were a Breakout where you play the
bricks and a Snake where every apple makes you shorter. Happy to hear what's broken.

## r/playmygame

Same as above, plus: made in a single index.html with no framework and no build step; the
arena is a Cloudflare Worker that referees every crash so the client can't lie about a score.

## Not written yet

- Show HN post — Snaked skipped this and it was the right call. Skip unless Lok says otherwise.
- Anything for X/Bluesky.
