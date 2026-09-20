# Re-Tron

Online light cycles: one shared arena, join any time.

Your bike leaves nothing behind until you switch on the blade. Then it lays a wall that knocks out anyone who rides into it, you included. The blade runs on charge: about 3s of wall per full charge, 6s to recharge, and a 1s wait if you run it dry. Bots top the arena up to 6 bikes when it is quiet. Barricades fade after 8s and vanish when their owner is knocked out.

- `index.html` — the game page (GitHub Pages: https://brendanlok.github.io/re-tron/), no build step.
- `server/` — the arena, a Cloudflare Worker + Durable Object that moves every bike and decides every crash.
  - Deploy: `cd server && npx wrangler deploy`
  - Run locally: `cd server && npx wrangler dev` then serve this folder and open it.
  - Check the arena rules: `node server/test-arena-headless.mjs` — no server, no network, deterministic.
  - Check a running server: `node server/test-arena.mjs` against `wrangler dev` (never the live one: test runs land on the board).
