# Re-Tron — launch copy

DRAFT, written 30 Sep by the scheduled session for Lok to edit. **Nothing here has been
posted.** Announcing the game is Lok's call; this folder only has the pieces ready.

Live link: https://brendanlok.github.io/re-tron/

Saturday's regression list runs as one command from the repo root: `python preflight.py`.
Thirteen checks, every one of them something that has gone stale silently before: the live
link serves the page in this folder, the itch zip is that same page, the preview image and
every icon still resolve, the arena answers the menu's two questions, the DEPLOYED worker
is the server in this folder (it reads the last deploy out of wrangler), and the arena
actually SEATS A BIKE AND RIDES IT. That last one matters most on Sunday morning: the two
cheap paths the menu uses never touch the tick, so a referee that throws on every tick
still answers both with a healthy 200 - every other check here would pass over an arena
nobody can play. It rides for six tenths of a second and never asks for the blade, so it
lays no wall, can own no knockout, scores 0, and the referee writes nothing down: unlike
`server/test-arena.mjs`, this one is safe to point at the live arena and does so by default.
Run it on its own with `node server/live-pulse.mjs`. Green means go.

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
file in itch's upload box and the file behind the link are the same game. Last run 1 Oct, both True.

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
