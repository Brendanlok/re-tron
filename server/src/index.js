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
// DIRS is the gate a player's turn has to get through (onMsg: `DIRS[m.d]`), so it must answer for the
// four directions and nothing else. A plain object literal answers for everything on Object.prototype
// too - `{t:'turn', d:'constructor'}` sailed through the check, set dir to 'constructor', and the next
// line of step() read DIRS[dir][0] off a function and moved the bike to NaN,NaN. Nothing there is a
// crash: every edge and collision test compares against NaN and comes back false, so the bike never
// died, never freed its seat, never let its socket go idle - the arena ticked on for it - and every
// rider was sent a bike at null,null. A null prototype is the whole fix: the four keys behave exactly
// as before (Object.keys and for..in still give U,D,L,R), and every inherited key is now undefined.
const DIRS = {__proto__: null, U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]};
const BACK = {__proto__: null, U: 'D', D: 'U', L: 'R', R: 'L'};
const DI = {__proto__: null, U: 0, D: 1, L: 2, R: 3};
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
    // n is every attempt this minute, read before a stranger's body is; say and err are what each
    // kind has actually spent of its own allowance - see say()
    this.said = {n: 0, say: 0, err: 0, at: 0};
    // Storage faults inside the tick are invisible from outside otherwise - see kill(). Counted
    // here rather than in reset(), so the trace outlives the arena it happened in.
    this.lost = 0;
    // And the other way the arena can go quiet on a player, which the comment on say()'s own guard
    // admitted was invisible: a note the flood guards REFUSE is not a storage fault, so it is not in
    // this.lost, and nothing anywhere said it had happened. The two allowances were split by kind on
    // 2026-10-22 so the page's crash reports cannot drown out the players - but a player who was
    // refused still reads 'could not send, try again in a moment' and almost nobody does, and the only
    // channel there is for hearing from players had turned them away with nobody the wiser. Counted
    // beside this.lost and carried the same cheap way, for the same reason: it is the only way anyone
    // outside this object ever finds out.
    this.turned = 0;
    // When THIS instance started, which is a different question from when the Worker was last deployed
    // and the only one that says what the referee is actually playing by. A warm Durable Object goes on
    // running the code it was built with until it is recycled: measured 2026-10-22, a deploy was current
    // the moment wrangler said so and the arena answered by the OLD rules for five more minutes, six
    // probes - stale, stale, stale, stale, stale, correct. An instance that woke BEFORE a deploy landed
    // cannot be running it, so this is carried on /count and the launch checklist compares the two. Set
    // here and never in reset(), for the same reason this.lost is: the ride is rebuilt when the last
    // rider leaves, the instance and its code are exactly as old as they were.
    this.woke = Date.now();
    // THE BOARD IS READ FAR MORE OFTEN THAN IT CHANGES, and every read of it walks the whole table.
    // Three of them do: /top groups by name twice (today and all time), and riderName() reads every
    // DISTINCT name on every anonymous join, which on launch day is most of them. The page asks /top
    // on every menu view AND again after every run, so rows read grows with visitors TIMES runs on the
    // board - measured 2026-10-25, the free allowance for rows read is spent partway through a day of
    // about 790 visitors and the board then goes dark until midnight UTC. That measurement concluded
    // the only lever was the SIZE of the table, which would mean deleting runs players can see; the
    // lever it missed is the NUMBER OF TIMES the query runs. Nothing about the table changes between
    // those reads, so the answers are kept here and handed out again until something writes to runs -
    // which happens in exactly three places (the score write in kill, and the two admin deletes in
    // board), all of them inside this one object, so dropping it there is complete rather than hopeful.
    // A cold instance recomputes exactly as before; a busy one - the only case that can reach the
    // allowance - reads the table once instead of once per visitor.
    // ponytail: a held answer, not a cache. No size, no expiry, no timer, so it cannot keep the arena
    // awake and cannot cost a second of duration. Give it a real one only if the table ever needs it.
    this.memo = {};
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
    if (path === '/count') {
      const on = [...this.bikes.values()].filter(b => !b.bot).length;
      // guarded storage still loses the row, and a lost run with no trace is a silent failure. Carried
      // on the one cheap path something already asks for, and only once something has actually failed,
      // so the answer every menu reads is unchanged.
      // built field by field rather than as one ternary, so a second trace does not double the shapes
      // this answers in: absent is the normal answer for both, and the menu reads nothing but `on`.
      const r = {on};
      // always, unlike the two traces below: it is not a fault report, it is the one fact nothing
      // outside this object can find out any other way (see this.woke). The menu reads only `on`.
      r.up = Math.round((Date.now() - this.woke) / 1000);
      if (this.lost) r.lost = this.lost;
      if (this.turned) r.turned = this.turned;
      return Response.json(r, {headers: {'access-control-allow-origin': '*'}});
    }
    // EVERY PATH BELOW TOUCHES STORAGE, and none of them was guarded. The two calls inside step() were
    // (kill and riderName, 2026-10-21), but a throw on this side does not land in the tick - it lands in
    // the Durable Object's fetch, and Cloudflare turns that into a 500 of its own HTML with none of the
    // CORS headers these paths set. Measured 2026-10-22 against the real referee with a store that
    // throws: /top, /say and /board all threw straight out of fetch(), and this.lost stayed 0 while
    // /count went on answering {"on":0} as if nothing were wrong. So a storage fault on the request
    // path left NO trace anywhere - which is the half yesterday's fix did not reach, on the very
    // surface whose own comment says it must not answer 500 the day something genuinely breaks.
    // WHAT IT COSTS THE PLAYER, and it is different on each path. The board is the lie: the menu shows
    // its "didn't load" line, which reads as a cold server rather than as a board nobody can write to.
    // The report is the loss: the page reads a failed /say as a reason to give the slot back and fire
    // again, nine attempts and then nothing for the rest of the visit, having filed the crash nowhere.
    // 503 WITH THE CORS HEADER reads to the page exactly as the dropped request already did - the board
    // keeps its line, the report keeps its retry, no player sees anything new - while the count finally
    // admits it, which is the only way anyone outside this object ever finds out.
    try {
      // the board, read the same cheap way: the menu asks for it without ever waking the arena
      if (path === '/top') return Response.json(this.topAnswer(),
        {headers: {'access-control-allow-origin': '*'}});
      // awaited rather than handed straight back: say() is async, so its rejection would sail past a
      // sync catch and be the same uncaught 500 all over again
      if (path === '/say') return await this.say(req);
      // clearing the board. GET lists every run; POST ?wipe=1 empties it and POST ?name=RIDER drops that
      // rider's runs, then both list what is left. Removing anything needs a POST, so nothing that merely
      // follows the link — a preview, a prefetch, a bookmark — can empty the board by accident.
      if (path === '/board') return this.board(req);
      // the inbox, cleaned the same way as the board: GET lists it, POST ?name=WRITER drops that
      // writer's notes. This used to say filtering could wait, and that stopped being true the day the
      // launch checklist started filing a note of its own on every run - by launch morning there are
      // more of those sitting on top of the list than there are player reports underneath it.
      if (path === '/inbox') return this.inbox(req);
    } catch (e) {
      this.lost++; console.error('storage fault on ' + path, e);
      return new Response('the arena cannot reach its storage', {status: 503,
        headers: {'access-control-allow-origin': '*'}});
    }
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
    // JSON.parse only throws on text that is not JSON. 'null' IS JSON, so it sailed past the catch and
    // every branch below reads m.t off it - a TypeError thrown out of the websocket's message handler.
    // Measured 2026-10-21 against a real wrangler dev arena: the rider who sent it was cut off at once
    // with an abnormal 1006 close and no reason, which the page can only read as "the arena dropped
    // out". Everyone else kept their tick, so this is one seat rather than the arena - but it is a
    // four-byte message, and this handler is the one thing a stranger can reach that holds a live bike.
    // Nothing the page sends is anything but an object, so that is what the gate asks for.
    if (!m || typeof m !== 'object') return;
    const b = s.bike && s.bike.alive ? s.bike : null;
    if (m.t === 'join' && !b) {
      // bikes AND the sockets already let in and still waiting for room: on a crowded board spawn()
      // legitimately comes up empty and step() keeps retrying, so counting bikes alone let everyone
      // who asked on the same tick through the check at once and the arena ended up busier than the cap
      const humans = [...this.bikes.values()].filter(x => !x.bot).length
        + [...this.socks].filter(x => x !== s && x.waiting !== undefined).length;
      // the number the referee actually counted goes with the refusal: the menu's own rider count is
      // up to 20s old, and a visitor told "arena is full" under a line reading "9 riders in the arena now"
      // reads a broken page rather than a busy one
      if (humans >= MAX_HUMANS) return this.send(s, {t: 'full', on: humans});
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
    // where, not just who: the page hides the menu the moment this lands, and without a position it
    // has no bike to put the camera on until the next tick - so the first tenth of a second of every
    // run was the whole arena at menu zoom, then a hard snap onto a bike that had appeared from nowhere
    // and the standings, because the broadcast only carries them once a second: joining on any other
    // tick left the corner panel showing the LAST run's rows for up to 900ms - and the arena resets its
    // ids to 1 whenever the last socket goes, so one of those dead rows could carry the new rider's own
    // id and light up as him, which is the name-matching bug of 18 Oct coming back through staleness.
    // and WHICH TICK it is, because the page starts its own "alive" clock from the last tick it has
    // been given, and that is not the tick this seat was cut on. A join is handled the moment it
    // arrives rather than on a tick boundary, so any tick that is still in flight when it lands is one
    // the page has not applied: measured on this referee, a seat cut on tick 21 against a page still
    // holding 20 had the HUD reading 0.1s while the referee said 0.0, and the gap rode out the whole
    // run. The remaining time in the current tick is what the join has to beat, and it is anywhere in
    // 0-100ms, so on a phone with 60ms of round trip most joins lose that race and a slow one loses it
    // by two ticks. The referee knows the number; send it rather than let the page guess.
    this.send(s, {t: 'you', id: b.id, k: this.tick, b: this.pack(b), top: this.topRows()});
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
  // ROAD, measured 2026-10-01: both caps here used to stop at 18-20 cells, which is 2.0s at ten ticks
  // a second - so the search could not tell 2 seconds of road from 5, and stopped the moment it found
  // 1.8s. In a busy arena with blades out, a third of riders were dropped with under 2.5s in front of
  // them and the worst got 1.4s, on a board where 5.5s was always available somewhere. That is a new
  // player pressing Start, looking for the pad, and hitting the arena wall having never touched a
  // control - the first thing a launch-day visitor would see. Both caps now reach 3s, and the weight
  // is scaled so road still counts for at most 72 points against distance-from-rivals' 80: this buys
  // a longer straight, it does not start trading rivals away for one.
  spawn(name, bot) {
    let bestAt = null, bestScore = -Infinity;
    for (let tries = 0; tries < 60; tries++) {
      const x = 3 + Math.floor(Math.random() * (W - 6)), y = 3 + Math.floor(Math.random() * (H - 6));
      if (this.owner[y * W + x]) continue;
      const dir = Object.keys(DIRS).sort((a, b) => this.room(x, y, b) - this.room(x, y, a))[0];
      const ahead = this.room(x, y, dir);
      if (ahead < 10) continue;
      const near = Math.min(40, ...[...this.bikes.values()].map(o => Math.abs(o.x - x) + Math.abs(o.y - y)));
      const score = Math.min(ahead, 30) * 2.4 + Math.min(near, 20) * 4 + this.reach(y * W + x, 200) / 10;
      if (score > bestScore) { bestScore = score; bestAt = [x, y, dir, near]; }
      if (near >= 14 && ahead >= 30) break;   // good enough, stop looking
    }
    if (bestAt && bestAt[3] >= 8) {
      const [x, y, dir] = bestAt;
      const b = {id: this.nextId++, x, y, dir, queue: [], alive: true, bot, name: name || '', charge: FULL, gap: 0,
        blade: false, want: false, kos: 0, start: this.tick, bladeFor: 0};
      if (bot) b.name = this.botName(b);   // one nobody in the arena is using
      else if (!b.name) b.name = this.riderName(b.id);   // before the announcement below, or everyone is told a blank
      this.bikes.set(b.id, b);
      this.out.n.push([b.id, b.name, bot ? 1 : 0]);
      // botName() runs when the BOT arrives, so it only ever looked at who was already out there.
      // A rider arriving LATER was never checked against the bots, and the ten bot names are the words a
      // player in a Tron game actually reaches for - NEON, GRID, ION, ARC. Measured 2026-10-22 on this
      // referee: a player typing a bot's name shared it with that live bot in 50 of 60 runs, and in 3 of
      // them the corner's rider list showed the one name on two rows at once, which is exactly the thing
      // the 8 Oct fix in botName() was written to stop. The bot gives way rather than the rider: it typed
      // nothing. Renamed after the set() above, so the rider's own name counts as taken.
      if (!bot) for (const o of this.bikes.values())
        if (o.bot && o !== b && o.name === b.name) { o.name = this.botName(o); this.out.n.push([o.id, o.name, 1]); }
      return b;
    }
    return null;
  }
  // Bot names used to go by id % 10, and ids climb for ever - so the list came round again while the
  // earlier bot of that name was still riding. Measured 2026-10-08 over 6000 ticks: two live bots
  // shared a name on 736 of them in one run and 1092 in another, so better than one tick in ten
  // either way, first about two minutes in - and the HUD's rider list is drawn by name, so a player
  // saw the same name twice on two adjacent rows. Take one nobody in the arena is using, humans
  // included, so a bot never shadows a rider's own name either. 10 names against TARGET 6, so one is
  // always free; the old rule stays as the fallback rather than risk a nameless bike.
  botName(b) {
    const taken = new Set([...this.bikes.values()].map(o => o.name));
    return BOT_NAMES.find(n => !taken.has(n)) || BOT_NAMES[b.id % BOT_NAMES.length];
  }

  // open cells straight ahead, up to 30 - three seconds of riding, the most the spawn scorer rewards
  room(x, y, d) {
    let n = 0;
    for (let k = 1; k <= 30; k++) {
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
    // A storage write that throws here took the whole arena down with it, not just this row: it runs
    // inside step(), so the tick aborted mid-way and nothing past this point ran - and the same dead
    // rider sat in the same crash on the next tick, so it never recovered. Measured 2026-10-21 on the
    // real referee: every bike frozen for every rider for as long as anyone stayed, while /count and
    // /top went on answering 200, which is the exact "answers but cannot be played" hole live-pulse
    // exists to catch. If storage is broken the row is lost either way; the arena need not be.
    if (!b.bot && b.name && score > 0)
      try {
        this.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)',
          today(), b.name, score, Math.round(secs * 10) / 10, b.kos, Date.now());
        // the board just changed, so the held /top answer is stale (see the constructor). The held
        // NAME list is not: an INSERT can only ADD to the DISTINCT name set, and this is the name it
        // added - so it is carried over rather than re-read. That read is the one that runs on every
        // anonymous join, so dropping it here spent a full-table scan per visitor to learn a name we
        // already had. Only a DELETE can take a name OUT, and board() drops the whole memo for that.
        const names = this.memo.names;
        this.memo = names ? {names: names.includes(b.name) ? names : [...names, b.name]} : {};
      } catch (e) { this.lost++; console.error('run not recorded', e); }
  }

  // The name the arena gives a rider who typed none, which on launch day is most of them: the box is
  // blank for a first-time visitor and Start works without it. It used to be 'RIDER' + the bike id, and
  // reset() puts nextId back to 1 every time the last socket goes - after nearly every run, as things
  // stand - so one anonymous rider after another was RIDER1. The board groups BY NAME and keeps the best
  // score, so two strangers came back as a single row: the one who scored less is not on the board at
  // all, under a result screen that has just told them to look for their name on it. Take a number no
  // rider in the arena and no run on the board is using, the way bot names are taken - the board is what
  // merges by name, so the board is what has to be read. Three digits keeps it inside the same eight
  // characters a typed name is cut to.
  riderName(id) {
    const taken = new Set([...this.bikes.values()].map(o => o.name));
    // and the same for this read, which is the worse of the two: it runs on every anonymous join, so
    // a throw froze the arena on the FIRST tick and for everyone. Without the board the walk below
    // still returns a name nobody in the arena is using - a possible collision with a name on the
    // board is a far smaller thing than a board nobody can ride on.
    // held like the board answer above it, and for the same reason: this read is the one that runs on
    // every anonymous join. A throw leaves nothing assigned, so a fault is never held on to.
    try {
      if (!this.memo.names) this.memo.names = [...this.sql.exec('SELECT DISTINCT name FROM runs')].map(r => r.name);
      for (const n of this.memo.names) taken.add(n);
    } catch (e) { this.lost++; console.error('board unreadable', e); }
    // walk from a random start rather than retrying at random: a free number is then always found
    // rather than usually found, and the names still do not read as a counter
    const walk = (span, label) => {
      const from = Math.floor(Math.random() * span);
      for (let i = 0; i < span; i++) {
        const n = 'RIDER' + label((from + i) % span);
        if (!taken.has(n)) return n;
      }
      return null;
    };
    // The 900 three-digit names are the ones a player should see, so they are taken first. But the set
    // read above is every name the BOARD has ever held, not the handful in the arena right now, and the
    // board is never pruned - so the pool is spent once 900 anonymous riders have SCORED, not once 900
    // are riding at the same time. Past that the old code fell back to 'RIDER' + the bike id, and
    // reset() puts ids back to 1 whenever the last socket goes: measured on this referee with 900 names
    // on the board, two strangers in two arena lifetimes were both called RIDER1, and the board keeps
    // the best run per NAME, so it showed the pair of them as one row with the loser missing - the
    // 18 Oct merge bug coming back on the day the game gets busy enough to matter. Three base-36
    // characters is the same eight letters wide and holds 46,656 names, so the fallback is unique
    // rather than merely different, and the pool cannot run out in the life of the game.
    return walk(900, n => 100 + n)
      || walk(46656, n => n.toString(36).toUpperCase().padStart(3, '0'))
      || 'RIDER' + id;   // 46,656 at once does not happen, but a nameless bike is never written down
  }

  // The whole /top answer, held until something writes to runs. Keyed on the day as well, because a
  // warm instance carries the held answer across midnight UTC and would otherwise go on calling
  // yesterday's rows Today - the one way this could tell a player something untrue rather than merely
  // old. Built only on a miss, so a storage fault throws out to the 503 guard with nothing held.
  topAnswer() {
    const day = today();
    if (!this.memo.top || this.memo.top.day !== day)
      this.memo.top = {day, today: this.top(day), all: this.top(null)};
    return this.memo.top;
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
      this.memo = {};   // the launch-morning wipe must show on the very next /top, not the next run
    }
    return Response.json([...this.sql.exec('SELECT day, name, score, secs, kos, at FROM runs ORDER BY at DESC LIMIT 500')]);
  }

  // Lok taking the checklist's own test notes off the player inbox, so what is left is what people
  // actually wrote. Same shape as board() above, and POST for the same reason: nothing that merely
  // follows the link can delete anything. Names are stored cut to 8 characters, so the checklist's
  // notes are named PREFLIGH, not PREFLIGHT - that is what to ask for.
  // ponytail: no ?wipe=1 here, unlike the board. The whole point of this list is the player reports,
  // so a one-word footgun that deletes them has no business existing. Per-writer is the only need.
  inbox(req) {
    const q = new URL(req.url).searchParams;
    if (req.method === 'POST') {
      if (!q.get('name')) return new Response('ask for ?name=WRITER', {status: 400});
      this.sql.exec('DELETE FROM notes WHERE name = ?', q.get('name'));
    }
    return Response.json([...this.sql.exec('SELECT kind, name, body, ua, at FROM notes ORDER BY at DESC LIMIT 200')]);
  }

  // A note from a player, or a crash the page caught itself. Everything is capped and nothing is trusted:
  // this is the one endpoint a stranger can write to.
  // ponytail: the flood guard counts in memory, which is fine here and only here — the Durable Object
  // is a single instance, unlike a Worker isolate. A wake resets the count; storage is cheap, wiping is Lok's.
  async say(req) {
    const now = Date.now(), cors = {'access-control-allow-origin': '*'};
    if (now - this.said.at > 60000) this.said = {n: 0, say: 0, err: 0, at: now};
    // The ceiling on how many bodies a stranger can make this object READ in a minute, which is the
    // only thing that can be judged before the body is read: req.text() has no size of its own, and the
    // kind the allowances below are spent from is inside it. Set above the fifty the two of them can
    // spend together, so it binds on a flood and never on real traffic.
    if (++this.said.n > 60) { this.turned++; return new Response('slow down', {status: 429, headers: cors}); }
    let m; try { m = JSON.parse(await req.text()); } catch (e) { return new Response('bad', {status: 400, headers: cors}); }
    // The same four bytes that threw a rider off their bike this morning, on the other half of the
    // surface: 'null' IS valid JSON, so it sails past the catch above and `m.body` on the next line is
    // a TypeError thrown out of the Durable Object's fetch handler. Measured 2026-10-21 against a real
    // wrangler dev arena with two riders on it, because the blast radius had to be measured rather than
    // assumed: the riders kept every tick and /count never moved, so this is the one request and not the
    // arena. What it does cost is the shape of the answer - Cloudflare turns the throw into a 500 of its
    // own HTML with none of the CORS headers this endpoint sets, so a browser reads it as a network
    // failure rather than a refusal. This is the one path a stranger can write to, and the one path a
    // real storage fault would also surface on; it must not answer 500 to a malformed body, or the day
    // something genuinely breaks here the 500 will look like business as usual. Same gate as onMsg.
    if (!m || typeof m !== 'object') return new Response('bad', {status: 400, headers: cors});
    const cut = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
    const body = cut(m.body, 600).trim();
    if (!body) return new Response('empty', {status: 400, headers: cors});
    const kind = m.kind === 'err' ? 'err' : 'say';
    // ONE ALLOWANCE SHARED BY BOTH KINDS WAS THE WRONG SHAPE, and the two kinds are not equals. A player
    // typing into the box sends one note, deliberately, because something is wrong. The page's own error
    // reporter sends up to nine on its own with nobody asking, and one broken frame fires it every tick -
    // so a single browser the game throws on spent nine of the thirty by itself, and four such visitors
    // in a minute spent them all. Everything after that was refused, the player typing "the blade button
    // does nothing on my phone" included, and the page shows that refusal as "could not send, try again
    // in a moment", which almost nobody does. On the one day the link gets a crowd, the only channel there
    // is for hearing from players could have been drowned out by the game's own crash reports, and nothing
    // anywhere would have said so: a 429 is not a storage fault, so it is not in this.lost and the count
    // says nothing about it. An allowance each is the fix. A refused report cannot take a player's slot,
    // because it is not spending from the same pot any more.
    // ponytail: a slice each, not per-writer limiting - there is no identity here to limit by, and the
    // kind is the client's word anyway. Someone malicious just says 'say'; the ceiling above is what
    // answers for them. This is about the honest page not shouting over its own players.
    if (++this.said[kind] > (kind === 'err' ? 20 : 30)) {
      this.turned++;
      return new Response('slow down', {status: 429, headers: cors});
    }
    this.sql.exec('INSERT INTO notes VALUES (?, ?, ?, ?, ?)',
      kind, cut(m.name, 8), body, cut(req.headers.get('user-agent'), 160), now);
    return new Response('ok', {headers: cors});
  }

  step() {
    // The page hangs up the moment its rider is knocked out. A socket still here 30s later with no bike
    // is a phone that lost signal without saying goodbye (no close ever arrives), or someone holding the
    // arena open on purpose - either way it would keep this tick, and the bill, running for nobody.
    // Hang up on it ourselves.
    // A socket still WAITING for a seat used to be exempt from this, and that exemption was the one way
    // left for a socket with no bike to hold the arena - and the bill - open for ever. Measured
    // 2026-10-21 on the real referee: one socket with a join the referee could not seat sat through 1200
    // ticks with its idle counter pinned at 0, the tick climbing and the timer running, while the same
    // socket without a pending join was hung up on at 300 and the arena stopped. Invisible from outside,
    // too: /count reports non-bot BIKES, so it answers on:0 the whole time an arena like that is awake.
    // The exemption protected nobody - the page gives up and closes after 10s of not riding, and 300
    // ticks is 300 retries of trySpawn; measured over 300s of twelve riders all blading, not one join
    // waited even a single tick. A board that cannot seat anyone for 30s is not a queue to be patient
    // with.
    for (const s of this.socks) {
      s.idle = s.bike && s.bike.alive ? 0 : (s.idle || 0) + 1;
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
    // A bike heading off the left or right edge has nx = -1 or W, and ny * W + nx then lands on a real
    // cell one row away at the far side. Counted as a target, it killed whoever was legitimately riding
    // into that cell for a head-on with a bike that was already off the board - an unexplainable death,
    // across the arena, from nothing. Off the board collides with nobody; the edge check has it anyway.
    const target = new Map();
    for (const b of live) {
      if (b.nx < 0 || b.ny < 0 || b.nx >= W || b.ny >= H) continue;
      const k = b.ny * W + b.nx; target.set(k, (target.get(k) || 0) + 1);
    }
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
      msg.top = this.topRows();
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
  // The standings the corner of the arena shows. The id goes with the name, because nothing stops two
  // riders typing the same one: the page used to find itself in this list by NAME, so both LOKs lit up
  // as you and the stranger's score sat on top of your own. Appended last, so a page served from cache
  // mid-deploy reads the first three fields exactly as before.
  topRows() {
    return [...this.bikes.values()].map(b => [b.name, Math.floor((this.tick - b.start) / 10) + 10 * b.kos, b.bot ? 1 : 0, b.id])
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
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
