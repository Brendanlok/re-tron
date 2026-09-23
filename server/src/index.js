// Re-Tron arena server: one Cloudflare Durable Object runs the one shared arena and is the referee for every move.
// Clients only send inputs (join / turn / blade); every tick the server moves all bikes and broadcasts the result.

const W = 40, H = 60, TICK_MS = 100;
const BLADE_TICKS = 30;      // a full charge lasts 3s of blade
const RECHARGE_TICKS = 60;   // empty to full in 6s
const EMPTY_GAP = 10;        // run it dry and recharging waits 1s first
const FULL = 600;            // charge is kept in sixths of a percent, so 3s of blade (20 a tick) and
                             // 6s of recharge (10 a tick) are whole numbers: a float here made the blade last 3.1s
const WALL_TICKS = 80;       // a barricade stands for 8s
const TARGET = 6;            // bots top the arena up to this many bikes
const MAX_HUMANS = 12;
const IDLE_TICKS = 300;     // a socket with no bike on it for 30s gets hung up on (see step)
const DIRS = {U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]}, BACK = {U: 'D', D: 'U', L: 'R', R: 'L'};
const DI = {U: 0, D: 1, L: 2, R: 3};
const BOT_NAMES = ['VOLT', 'NEON', 'ARC', 'FLUX', 'ION', 'GRID', 'PULSE', 'ZAP', 'RAY', 'HEX'];
const today = () => new Date().toISOString().slice(0, 10);   // one UTC day for everyone, like Snaked's board

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    // ponytail: one arena for everyone; open a second one by name when MAX_HUMANS is actually hit
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', {status: 426});
      return env.ARENA.get(env.ARENA.idFromName('main')).fetch(req);
    }
    // the menu asks how busy the arena is, and for the board, without opening a socket: an idle tab costs nothing
    if (url.pathname === '/count' || url.pathname === '/top')
      return env.ARENA.get(env.ARENA.idFromName('main')).fetch(req);
    // a player saying something broke, and the page reporting its own crash. Neither wakes the tick.
    if (url.pathname === '/say') {
      if (req.method === 'OPTIONS') return new Response(null, {headers: {'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST'}});
      if (req.method !== 'POST') return new Response('post it', {status: 405});
      return env.ARENA.get(env.ARENA.idFromName('main')).fetch(req);
    }
    // reading the inbox, and clearing junk runs off the board, behind the ADMIN secret.
    // Unset means nobody gets in, rather than everybody.
    if (url.pathname === '/inbox' || url.pathname === '/board') {
      if (!env.ADMIN || url.searchParams.get('key') !== env.ADMIN) return new Response('no', {status: 403});
      return env.ARENA.get(env.ARENA.idFromName('main')).fetch(req);
    }
    return new Response('Re-Tron arena server', {status: url.pathname === '/' ? 200 : 404});
  },
};

export class Arena {
  constructor(ctx) {
    this.socks = new Set();
    this.timer = null;
    // The board outlives the arena: this.reset() wipes the ride, storage keeps the runs.
    // ponytail: no pruning — a few thousand rows is nothing. Prune by day if it ever gets big.
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS runs (day TEXT, name TEXT, score INTEGER, secs REAL, kos INTEGER, at INTEGER)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS runs_day ON runs (day, score)');
    // Anything that fails silently is a launch blocker, so both ways of hearing about it land in one table:
    // kind 'say' is a player typing it, kind 'err' is the page reporting its own crash.
    this.sql.exec('CREATE TABLE IF NOT EXISTS notes (kind TEXT, name TEXT, body TEXT, ua TEXT, at INTEGER)');
    this.said = {n: 0, at: 0};
    this.reset();
  }
  reset() {
    this.bikes = new Map();
    this.nextId = 1;
    this.tick = 0;
    this.owner = new Uint32Array(W * H);   // 0 = open floor, n = barricade laid by bike n
    this.born = new Uint32Array(W * H);
    this.walls = [];                       // [cell, born] in the order they were laid, for expiry
    this.out = {a: [], c: [], e: [], n: []};
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    // a plain count: it must never start the tick, or asking the question would cost as much as playing
    if (path === '/count')
      return Response.json({on: [...this.bikes.values()].filter(b => !b.bot).length},
        {headers: {'access-control-allow-origin': '*'}});
    // the board, read the same cheap way: the menu asks for it without ever waking the arena
    if (path === '/top') return Response.json({day: today(), today: this.top(today()), all: this.top(null)},
      {headers: {'access-control-allow-origin': '*'}});
    if (path === '/say') return this.say(req);
    // clearing the board. GET lists every run; POST ?wipe=1 empties it and POST ?name=RIDER drops that
    // rider's runs, then both list what is left. Removing anything needs a POST, so nothing that merely
    // follows the link — a preview, a prefetch, a bookmark — can empty the board by accident.
    if (path === '/board') return this.board(req);
    // newest first, everything in one list: there is little enough of it that filtering can wait
    if (path === '/inbox') return Response.json(
      [...this.sql.exec('SELECT kind, name, body, ua, at FROM notes ORDER BY at DESC LIMIT 200')]);
    const pair = new WebSocketPair(), ws = pair[1];
    ws.accept();
    const s = {ws, bike: null, count: 0, windowAt: Date.now(), idle: 0};
    this.socks.add(s);
    ws.addEventListener('message', e => this.onMsg(s, e.data));
    ws.addEventListener('close', () => this.drop(s));
    ws.addEventListener('error', () => this.drop(s));
    this.send(s, {t: 'hi', W, H, k: this.tick, wallTicks: WALL_TICKS, tickMs: TICK_MS,
      walls: this.walls.filter(([c, b]) => this.born[c] === b && this.owner[c]).map(([c, b]) => [c, this.owner[c], b]),
      bikes: [...this.bikes.values()].map(b => this.pack(b)), names: [...this.bikes.values()].map(b => [b.id, b.name, b.bot ? 1 : 0])});
    this.start();
    return new Response(null, {status: 101, webSocket: pair[0]});
  }

  onMsg(s, raw) {
    const now = Date.now();
    if (now - s.windowAt > 1000) { s.windowAt = now; s.count = 0; }
    if (++s.count > 40 || typeof raw !== 'string' || raw.length > 200) return;   // flood guard
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const b = s.bike && s.bike.alive ? s.bike : null;
    if (m.t === 'join' && !b) {
      const humans = [...this.bikes.values()].filter(x => !x.bot).length;
      if (humans >= MAX_HUMANS) return this.send(s, {t: 'full'});
      const name = String(m.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      s.waiting = name;   // spawn() can say "no room right now"; step() keeps trying
      this.trySpawn(s);
    } else if (m.t === 'turn' && b && DIRS[m.d]) {
      const last = b.queue.length ? b.queue[b.queue.length - 1] : b.dir;
      if (m.d !== last && m.d !== BACK[last] && b.queue.length < 2) b.queue.push(m.d);
    } else if (m.t === 'blade' && b) {
      b.want = !!m.on && b.charge > 0;   // a press during the empty wait is dropped, not saved to fire one stray cell later
    }
  }

  trySpawn(s) {
    if (s.waiting === undefined || (s.bike && s.bike.alive)) return;
    const b = this.spawn(s.waiting, false);
    if (!b) return;
    b.sock = s; s.bike = b; s.waiting = undefined;
    this.send(s, {t: 'you', id: b.id});
  }

  drop(s) {
    if (!this.socks.delete(s)) return;
    if (s.bike && s.bike.alive) this.kill(s.bike, 0, 'left');
    if (!this.socks.size) this.stop();
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.step(), TICK_MS); }
  stop() { clearInterval(this.timer); this.timer = null; this.reset(); }

  // Drop into the emptiest corner going, well away from anyone else: a fresh bike should get
  // a few seconds of clear road rather than spawning under someone's blade.
  spawn(name, bot) {
    let bestAt = null, bestScore = -Infinity;
    for (let tries = 0; tries < 60; tries++) {
      const x = 3 + Math.floor(Math.random() * (W - 6)), y = 3 + Math.floor(Math.random() * (H - 6));
      if (this.owner[y * W + x]) continue;
      const dir = Object.keys(DIRS).sort((a, b) => this.room(x, y, b) - this.room(x, y, a))[0];
      const ahead = this.room(x, y, dir);
      if (ahead < 10) continue;
      const near = Math.min(40, ...[...this.bikes.values()].map(o => Math.abs(o.x - x) + Math.abs(o.y - y)));
      const score = Math.min(ahead, 18) * 4 + Math.min(near, 20) * 4 + this.reach(y * W + x, 200) / 10;
      if (score > bestScore) { bestScore = score; bestAt = [x, y, dir, near]; }
      if (near >= 14 && ahead >= 18) break;   // good enough, stop looking
    }
    if (bestAt && bestAt[3] >= 8) {
      const [x, y, dir] = bestAt;
      const b = {id: this.nextId++, x, y, dir, queue: [], alive: true, bot, name: name || '', charge: FULL, gap: 0,
        blade: false, want: false, kos: 0, start: this.tick, bladeFor: 0};
      if (bot) b.name = BOT_NAMES[b.id % BOT_NAMES.length];
      else if (!b.name) b.name = 'RIDER' + b.id;   // before the announcement below, or everyone is told a blank
      this.bikes.set(b.id, b);
      this.out.n.push([b.id, b.name, bot ? 1 : 0]);
      return b;
    }
    return null;
  }
  // open cells straight ahead, up to 20
  room(x, y, d) {
    let n = 0;
    for (let k = 1; k <= 20; k++) {
      const nx = x + DIRS[d][0] * k, ny = y + DIRS[d][1] * k;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || this.owner[ny * W + nx]) break;
      n++;
    }
    return n;
  }

  kill(b, killer, reason) {
    b.alive = false;
    this.bikes.delete(b.id);
    for (let c = 0; c < this.owner.length; c++) if (this.owner[c] === b.id) this.owner[c] = 0;
    const secs = (this.tick - b.start) / 10, score = Math.floor(secs) + 10 * b.kos;
    this.out.c.push(b.id);
    this.out.e.push([b.id, killer, reason, score, this.tick - b.start, b.kos]);
    if (b.sock) b.sock.bike = null;
    // the referee records the run, so there is no score to forge: the client never sends one
    if (!b.bot && b.name && score > 0)
      this.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)',
        today(), b.name, score, Math.round(secs * 10) / 10, b.kos, Date.now());
  }

  // Best run per name, so one rider cannot fill the board. day = null means all time.
  top(day) {
    const where = day ? 'WHERE day = ?' : '', args = day ? [day] : [];
    // one MAX() and bare columns: SQLite then takes secs and kos from that same best row
    return [...this.sql.exec('SELECT name, MAX(score) AS score, secs, kos FROM runs ' +
      where + ' GROUP BY name ORDER BY score DESC, secs DESC LIMIT 10', ...args)]
      .map(r => [r.name, r.score, r.secs, r.kos]);
  }

  // Lok taking junk runs off the board. Two weeks of testing before launch leave rows nobody wants
  // players to see, and the all-time board is what the game is judged by on day one.
  // ponytail: a rider is deleted whole rather than run by run — the board only ever shows the best
  // run per name, so that is the row you are looking at. Per-run deletion if a real name ever needs it.
  board(req) {
    const q = new URL(req.url).searchParams;
    if (req.method === 'POST') {
      if (q.get('wipe') === '1') this.sql.exec('DELETE FROM runs');
      else if (q.get('name')) this.sql.exec('DELETE FROM runs WHERE name = ?', q.get('name'));
      else return new Response('ask for ?wipe=1 or ?name=RIDER', {status: 400});
    }
    return Response.json([...this.sql.exec('SELECT day, name, score, secs, kos, at FROM runs ORDER BY at DESC LIMIT 500')]);
  }

  // A note from a player, or a crash the page caught itself. Everything is capped and nothing is trusted:
  // this is the one endpoint a stranger can write to.
  // ponytail: the flood guard counts in memory, which is fine here and only here — the Durable Object
  // is a single instance, unlike a Worker isolate. A wake resets the count; storage is cheap, wiping is Lok's.
  async say(req) {
    const now = Date.now(), cors = {'access-control-allow-origin': '*'};
    if (now - this.said.at > 60000) this.said = {n: 0, at: now};
    if (++this.said.n > 30) return new Response('slow down', {status: 429, headers: cors});
    let m; try { m = JSON.parse(await req.text()); } catch (e) { return new Response('bad', {status: 400, headers: cors}); }
    const cut = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
    const body = cut(m.body, 600).trim();
    if (!body) return new Response('empty', {status: 400, headers: cors});
    this.sql.exec('INSERT INTO notes VALUES (?, ?, ?, ?, ?)',
      m.kind === 'err' ? 'err' : 'say', cut(m.name, 8), body, cut(req.headers.get('user-agent'), 160), now);
    return new Response('ok', {headers: cors});
  }

  step() {
    // The page hangs up the moment its rider is knocked out. A socket still here 30s later with no bike
    // and not waiting for one is a phone that lost signal without saying goodbye (no close ever arrives),
    // or someone holding the arena open on purpose - either way it would keep this tick, and the bill,
    // running for nobody. Hang up on it ourselves.
    for (const s of this.socks) {
      s.idle = (s.bike && s.bike.alive) || s.waiting !== undefined ? 0 : (s.idle || 0) + 1;
      if (s.idle > IDLE_TICKS) { try { s.ws.close(1000, 'idle'); } catch (e) {} this.drop(s); }
    }
    if (!this.socks.size) return;   // that was the last one: stop() has already reset the arena
    this.tick++;
    // bots top the arena up to TARGET bikes, and step aside one at a time when people join
    const all = [...this.bikes.values()];
    if (all.length < TARGET && this.tick % 5 === 0) this.spawn('', true);
    if (all.length > TARGET) { const bot = all.find(b => b.bot); if (bot) this.kill(bot, 0, 'left'); }

    for (const s of this.socks) this.trySpawn(s);

    const live = [...this.bikes.values()];
    for (const b of live) {
      if (b.bot) this.think(b);
      else while (b.queue.length) { const d = b.queue.shift(); if (d !== b.dir && d !== BACK[b.dir]) { b.dir = d; break; } }
      // charge: drains while the blade is out, then recharges; running dry adds a short wait first
      b.blade = b.want && b.charge > 0;
      if (b.blade) {
        b.charge -= FULL / BLADE_TICKS;
        if (b.charge <= 0) { b.charge = 0; b.want = false; b.gap = EMPTY_GAP; }
      } else if (b.gap > 0) b.gap--;
      else b.charge = Math.min(FULL, b.charge + FULL / RECHARGE_TICKS);
      b.nx = b.x + DIRS[b.dir][0]; b.ny = b.y + DIRS[b.dir][1];
    }
    // a bike with the blade out lays a barricade on the cell it is leaving
    for (const b of live) if (b.blade) this.lay(b.y * W + b.x, b.id);
    // expire old barricades
    while (this.walls.length && this.walls[0][1] + WALL_TICKS <= this.tick) {
      const [c, born] = this.walls.shift();
      if (this.born[c] === born) this.owner[c] = 0;
    }
    // crashes: edge, any barricade (yours too), two bikes into one cell, or two bikes swapping cells
    const target = new Map();
    for (const b of live) { const k = b.ny * W + b.nx; target.set(k, (target.get(k) || 0) + 1); }
    const dead = [];
    for (const b of live) {
      const k = b.ny * W + b.nx;
      if (b.nx < 0 || b.ny < 0 || b.nx >= W || b.ny >= H) dead.push([b, 0, 'edge']);
      else if (this.owner[k]) dead.push([b, this.owner[k] === b.id ? 0 : this.owner[k], this.owner[k] === b.id ? 'self' : 'wall']);
      else if (target.get(k) > 1 || live.some(o => o !== b && o.nx === b.x && o.ny === b.y && b.nx === o.x && b.ny === o.y)) dead.push([b, 0, 'head']);
    }
    const doomed = new Set(dead.map(d => d[0]));
    for (const b of live) if (!doomed.has(b)) { b.x = b.nx; b.y = b.ny; }
    // credit every knockout before anyone is written down: two riders who crash into each other's walls
    // on the same tick both get the KO, instead of whoever happened to be killed second
    for (const [, killer] of dead) { const k = this.bikes.get(killer); if (k) k.kos++; }
    for (const [b, killer, reason] of dead) this.kill(b, killer, reason);

    const msg = {t: 'k', k: this.tick, b: [...this.bikes.values()].map(b => this.pack(b))};
    for (const f of ['a', 'c', 'e', 'n']) if (this.out[f].length) msg[f] = this.out[f];
    if (this.tick % 10 === 0) {
      msg.top = [...this.bikes.values()].map(b => [b.name, Math.floor((this.tick - b.start) / 10) + 10 * b.kos, b.bot ? 1 : 0])
        .sort((a, b) => b[1] - a[1]).slice(0, 5);
      msg.on = [...this.bikes.values()].filter(b => !b.bot).length;
    }
    this.out = {a: [], c: [], e: [], n: []};
    const text = JSON.stringify(msg);
    for (const s of this.socks) try { s.ws.send(text); } catch (e) {}
  }

  lay(c, id) {
    this.owner[c] = id; this.born[c] = this.tick;
    this.walls.push([c, this.tick]);
    this.out.a.push([c, id]);
  }
  pack(b) { return [b.id, b.x, b.y, DI[b.dir], b.blade ? 1 : 0, Math.round(b.charge * 100 / FULL)]; }

  // Bots: pick the turn with the most open floor behind it (a capped flood fill), mostly go straight,
  // slip now and then so they can be beaten, and swing the blade out when someone is close.
  think(b) {
    let best = b.dir, bestScore = -Infinity;
    // With the blade out, the cell the bot is standing on becomes a barricade this very tick. Counting it
    // as open floor let the flood fill escape a pocket through the gap the bot was in the act of sealing,
    // so a bot would happily turn into a loop it had already closed: half of all knockouts were bots
    // riding into their own blade, which scores nobody anything. Block it for the length of the choice.
    const here = b.y * W + b.x, was = this.owner[here];
    if (b.want && b.charge > 0) this.owner[here] = b.id;
    for (const d of Object.keys(DIRS)) {
      if (d === BACK[b.dir]) continue;
      const x = b.x + DIRS[d][0], y = b.y + DIRS[d][1];
      if (x < 0 || y < 0 || x >= W || y >= H || this.owner[y * W + x]) continue;
      let s = this.reach(y * W + x, 160) + (d === b.dir ? 4 : 0) + Math.random() * 5;
      for (const o of this.bikes.values()) if (o !== b && Math.abs(o.x - x) + Math.abs(o.y - y) <= 1) s -= 60;
      if (Math.random() < 0.06) s = Math.random() * 200;
      if (s > bestScore) { bestScore = s; best = d; }
    }
    this.owner[here] = was;
    b.dir = best;
    if (b.bladeFor > 0) { if (--b.bladeFor === 0) b.want = false; return; }
    if (!b.blade && b.charge > FULL * 0.6 && Math.random() < 0.3 &&
        [...this.bikes.values()].some(o => o !== b && this.tick - o.start > 20 &&   // give a fresh rider 2s before hunting them
          Math.abs(o.x - b.x) + Math.abs(o.y - b.y) < 7)) {
      b.want = true; b.bladeFor = 8 + Math.floor(Math.random() * 14);
    }
  }
  reach(from, cap) {
    const seen = new Uint8Array(W * H), q = [from]; seen[from] = 1;
    for (let i = 0; i < q.length && q.length < cap; i++) {
      const x = q[i] % W, y = (q[i] / W) | 0;
      for (const d in DIRS) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1], k = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[k] || this.owner[k]) continue;
        seen[k] = 1; q.push(k);
      }
    }
    return q.length;
  }

  send(s, m) { try { s.ws.send(JSON.stringify(m)); } catch (e) {} }
}
