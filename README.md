# Re-Tron

Online light cycles: one shared arena, join any time.

Your bike leaves nothing behind until you switch on the blade. Then it lays a wall that knocks out anyone who rides into it, you included. The blade runs on charge: about 3s of wall per full charge, 6s to recharge, and a 1s wait if you run it dry. Bots top the arena up to 6 bikes when it is quiet. Walls fade after 8s and vanish when their owner is knocked out.

- `index.html` — the game page (GitHub Pages: https://brendanlok.github.io/re-tron/), no build step.
- `server/` — the arena, a Cloudflare Worker + Durable Object that moves every bike and decides every crash.
  - Deploy: `cd server` then `npx wrangler deploy` - it must run from `server/`, or wrangler
    says "Required Worker name missing". Two steps on purpose: `&&` is a parser error in
    PowerShell, and `;` would deploy from the wrong folder if the `cd` failed.
  - Run locally: `cd server` then `npx wrangler dev`, then serve this folder and open it.
    **This does not start on Lok's Windows machine as of 22 Oct 2026** and the failure is
    silent: it prints one `X [ERROR] spawn UNKNOWN`, then says `Starting local server...`
    for ever while no port opens. The cause is not wrangler - Windows Application Control
    blocks the `workerd.exe` miniflare spawns, which you only see by running that binary
    directly. Nothing in this folder can fix it and a session must not route around it, so
    do not spend an hour on it: use the two checks below, which need no local arena.
  - Check the arena rules: `node server/test-arena-headless.mjs` — no server, no network, deterministic.
  - Before announcing: `python preflight.py` from the repo root - the whole launch list in one
    command, run against the live arena by default. It seats a real bike and rides it, so green
    means playable and not merely reachable. `node server/live-pulse.mjs` is that check alone.
    An unattended run needs no flag: the one check that writes - a test note into the live
    player inbox that only the ADMIN secret can clear - is skipped automatically from inside
    a Claude session, off the CLAUDECODE env var rather than off a flag anyone has to
    remember. Every other check still runs, so a scheduled session can and should run this
    plain. Lok's own run in PowerShell does write the note, because the write half is the
    only proof the reports channel still saves what players send. `--no-note` forces the skip
    anywhere; `--note` forces the write from inside a session.
  - Check a running server: `node server/test-arena.mjs` against `wrangler dev`. It refuses a non-local arena, because it rides as LOK and TWO and asserts both runs are on the board - against the live one it plants two junk rows only the ADMIN secret can clear. `--live` overrides it.
    With `wrangler dev` blocked, this file has no platform on this machine: the only arena it
    can reach is the live one, and it refuses that for good reason. What it uniquely proved -
    the rules over a real socket - is covered between the two checks above it: the headless
    suite for every rule, `live-pulse.mjs` for a real socket taking a real seat. Keep it for
    the day a local arena runs again rather than reaching for it first.
