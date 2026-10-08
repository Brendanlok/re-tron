# Re-Tron

Online light cycles: one shared arena, join any time.

Your bike leaves nothing behind until you switch on the blade. Then it lays a wall that knocks out anyone who rides into it, you included. The blade runs on charge: about 3s of wall per full charge, 6s to recharge, and a 1s wait if you run it dry. Bots top the arena up to 6 bikes when it is quiet. Walls fade after 8s and vanish when their owner is knocked out.

- `index.html` — the game page (GitHub Pages: https://brendanlok.github.io/re-tron/), no build step.
- `server/` — the arena, a Cloudflare Worker + Durable Object that moves every bike and decides every crash.
  - Deploy: `cd server` then `npx wrangler deploy` - it must run from `server/`, or wrangler
    says "Required Worker name missing". Two steps on purpose: `&&` is a parser error in
    PowerShell, and `;` would deploy from the wrong folder if the `cd` failed.
  - Run locally: `cd server` then `npx wrangler dev`, then serve this folder and open it.
  - Check the arena rules: `node server/test-arena-headless.mjs` — no server, no network, deterministic.
  - Before announcing: `python preflight.py` from the repo root - the whole launch list in one
    command, run against the live arena by default. It seats a real bike and rides it, so green
    means playable and not merely reachable. `node server/live-pulse.mjs` is that check alone.
    Add `--no-note` for an unattended run: it skips the one check that writes, a test note into
    the live player inbox that only the ADMIN secret can clear. Everything else still runs. Lok's
    own run before announcing takes no flag, because the write half is the only proof the reports
    channel still saves what players send.
  - Check a running server: `node server/test-arena.mjs` against `wrangler dev`. It refuses a non-local arena, because it rides as LOK and TWO and asserts both runs are on the board - against the live one it plants two junk rows only the ADMIN secret can clear. `--live` overrides it.
