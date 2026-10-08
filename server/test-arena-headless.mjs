// Deterministic arena test: import the referee and drive step() by hand, with no network and
// (mostly) no bots. The live smoke test in test-arena.mjs can only check the charge rule when the
// test bike happens to survive six hunting bots; here nothing is hunting it, so the rule that sets
// the whole balance of the game gets checked on every run. Everything is read out of the broadcast
// the riders actually receive, so this checks what players are told, not just the server's own state.
import {Arena} from './src/index.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

let bad = 0;
const assert = (c, m) => { if (c) console.log('ok   ', m); else { console.log('FAIL ', m); bad++; } };
const is = (got, want, m) => assert(got === want, m + ' (' + got + (got === want ? '' : ', wanted ' + want) + ')');

// The Durable Object hands the Arena a SQLite handle. Most checks only need to know that a run was
// written down, so a list of rows stands in for it and reads come back empty. The board is different:
// it is a real query, and what a player sees leans on a SQLite rule about which row a bare column is
// taken from - so arena({board: true}) hands the referee node's own in-memory SQLite instead, and the
// board checks read back exactly the rows the menu would show.
function arena({bots = false, board = false} = {}) {
  const runs = [], feed = [];
  let sql;
  if (board) {
    const db = new DatabaseSync(':memory:');
    sql = {exec: (q, ...args) => {
      if (/^\s*SELECT/i.test(q)) return db.prepare(q).all(...args);
      db.prepare(q).run(...args);
      if (/^\s*INSERT/i.test(q)) runs.push(args);
      return [];
    }};
  } else {
    sql = {exec: (q, ...args) => { if (/^INSERT/.test(q)) runs.push(args); return []; }};
  }
  const a = new Arena({storage: {sql}});
  Object.assign(a, {runs, feed, sql});
  // one watcher records the broadcast, however many riders there are, so nothing is counted twice
  // its stand-in bike never dies, so the arena's idle hang-up leaves the watcher alone
  a.socks.add({ws: {send: t => feed.push(JSON.parse(t))}, bike: {alive: true}, count: 0, windowAt: Date.now()});
  if (!bots) { const real = a.spawn.bind(a); a.spawn = (n, bot) => bot ? null : real(n, bot); }
  return a;
}
// A rider, dropped exactly where the test wants it rather than wherever spawn felt like.
function rider(a, name, x, y, dir) {
  const b = a.spawn(name, false);
  if (!b) throw new Error('spawn found no room on an empty board');
  Object.assign(b, {x, y, dir, queue: []});
  const s = {ws: {send() {}}, bike: b, count: 0, windowAt: Date.now()};
  b.sock = s; a.socks.add(s);
  return {b, say: m => a.onMsg(s, JSON.stringify(m))};
}
const events = a => a.feed.flatMap(m => m.e || []);
const laid = (a, id) => a.feed.flatMap(m => m.a || []).filter(([, o]) => o === id).length;
const standing = (a, id) => [...a.owner].filter(o => o === id).length;

// ---- the charge cycle: 3s of blade, 1s waiting at zero, 6s back to full ----
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 2, 2, 'R');
  say({t: 'blade', on: true});
  const log = [];
  for (let i = 0; i < 120; i++) {
    // ride the perimeter, so the run lasts long enough to see a whole cycle and never meets its own wall
    if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'});
    else if (b.dir === 'D' && b.y >= 57) say({t: 'turn', d: 'L'});
    else if (b.dir === 'L' && b.x <= 2) say({t: 'turn', d: 'U'});
    else if (b.dir === 'U' && b.y <= 2) say({t: 'turn', d: 'R'});
    a.step();
    log.push([b.blade, a.pack(b)[5]]);
  }
  assert(b.alive, 'the rider survives a lap with nothing hunting it');
  is(log.filter(([on]) => on).length, 30, 'the blade runs for exactly 3s of ticks');
  is(log.findIndex(([on]) => !on), 30, 'and cuts out the moment the charge hits zero');
  is(log.filter(([, c]) => c === 0).length, 11, 'the charge then waits 1s at zero before recharging');
  is(log.findIndex(([, c], i) => i > 30 && c >= 100), 99, 'and is full again 6s after it starts climbing');
  is(laid(a, b.id), 30, 'one barricade cell for each tick the blade was out');
}

// ---- a tap while the charge sits empty is not saved up for later ----
// Pressing the blade during the 1s wait used to leave it armed, so the moment a sliver of charge came
// back it fired for one tick, laid one stray cell, ran dry and started the wait all over again.
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 2, 2, 'R');
  say({t: 'blade', on: true});
  for (let i = 0; i < 32; i++) { if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'}); a.step(); }
  is(a.pack(b)[5], 0, 'the blade has run dry and the charge is waiting at zero');
  say({t: 'blade', on: true});
  for (let i = 0; i < 20; i++) { if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'}); a.step(); }
  is(laid(a, b.id), 30, 'a press during the wait lays nothing once the charge comes back');
  say({t: 'blade', on: true});
  a.step();
  assert(b.blade, 'but a press once there is charge again deploys it');
}

// ---- barricades stand for 8s and then let go ----
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 2, 2, 'R');
  say({t: 'blade', on: true});
  for (let i = 0; i < 5; i++) a.step();
  say({t: 'blade', on: false});
  is(standing(a, b.id), 5, 'five ticks of blade leave five cells');
  for (let i = 0; i < 75; i++) { if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'}); a.step(); }
  is(standing(a, b.id), 5, 'the first cell is still standing at 7.9s');
  a.step();
  assert(standing(a, b.id) < 5, 'and has gone by 8s');
}

// ---- your own barricade kills you, and a knockout takes the dead rider's walls with it ----
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 20, 30, 'R');
  const id = b.id;
  say({t: 'blade', on: true});
  for (let i = 0; i < 5; i++) a.step();           // cells 20..24 on row 30, bike now at 25
  say({t: 'blade', on: false});
  say({t: 'turn', d: 'D'}); a.step();
  say({t: 'turn', d: 'L'}); for (let i = 0; i < 3; i++) a.step();
  say({t: 'turn', d: 'U'}); a.step();             // straight back into its own barricade
  const ev = events(a).find(e => e[0] === id);
  assert(ev && ev[2] === 'self', 'riding into your own barricade is a knockout (' + (ev ? ev[2] : 'no event') + ')');
  is(standing(a, id), 0, 'a knocked-out rider takes their barricades with them');
  is(a.bikes.size, 0, 'and leaves the arena');
  is(a.runs.length, 1, 'the referee wrote the run down');
  is(a.runs[0][2], ev[3], 'with the score it gave the rider, which the client never sends');
}

// ---- two bikes swapping cells both go: the case a naive "is that cell taken" check misses ----
{
  const a = arena();
  rider(a, 'ONE', 10, 10, 'R'); rider(a, 'TWO', 13, 10, 'L');
  a.step();                                        // 11 and 12: they pass, nobody crashes yet
  is(a.bikes.size, 2, 'both still riding as they close');
  a.step();                                        // now they try to trade places
  const why = events(a).map(e => e[2]);
  assert(why.length === 2 && why.every(r => r === 'head'), 'swapping cells knocks out both riders (' + why + ')');
}

// ---- two riders who crash into each other's walls on the same tick both get the knockout ----
// It used to go to whoever the referee happened to write down second, and the board kept that.
{
  const a = arena();
  const {b: one} = rider(a, 'ONE', 10, 10, 'R'), {b: two} = rider(a, 'TWO', 20, 10, 'L');
  a.lay(10 * 40 + 11, two.id); a.lay(10 * 40 + 19, one.id);   // each one's wall right in front of the other
  a.step();
  const ev = events(a);
  assert(ev.length === 2 && ev.every(e => e[2] === 'wall' && e[5] === 1), 'both are knocked out, each credited with the other (' + ev.map(e => e[2] + ':' + e[5]) + ')');
  assert(a.runs.length === 2 && a.runs.every(r => r[4] === 1), 'and both runs go on the board with it');
}

// ---- riding off the side of the arena takes nobody with you ----
// The cell a bike is moving into is kept as ny * W + nx. A bike heading off the left edge has nx = -1,
// so that lands on the last column of the row ABOVE - a real cell, right across the arena. Whoever was
// riding into it was knocked out for a head-on with a bike that had already left the board: a death with
// nothing on screen to explain it, and the only clue a "head-on crash" against thin air.
{
  const a = arena();
  const {b: off} = rider(a, 'EDGER', 0, 5, 'L');    // nx = -1, ny = 5  ->  the same index as (39, 4)
  const {b: safe} = rider(a, 'INNOC', 38, 4, 'R');  // legitimately riding into (39, 4)
  a.step();
  const ev = events(a);
  is(ev.length, 1, 'only the rider who left the board is knocked out');
  assert(ev[0][0] === off.id && ev[0][2] === 'edge', 'and it is filed as the edge, not a head-on');
  assert(safe.alive && safe.x === 39 && safe.y === 4, 'the rider across the arena carries on (' + safe.x + ',' + safe.y + ')');
}

// the same wrap the other way: off the right edge lands on the first column of the row BELOW
{
  const a = arena();
  rider(a, 'EDGER', 39, 5, 'R');
  const {b: safe} = rider(a, 'INNOC', 1, 6, 'L');
  a.step();
  is(events(a).length, 1, 'off the right edge is no different');
  assert(safe.alive, 'and the rider on the far side is left alone');
}

// ---- the edge ----
{
  const a = arena();
  const {b} = rider(a, 'LOK', 37, 10, 'R');
  for (let i = 0; i < 3; i++) a.step();
  assert(events(a).some(e => e[0] === b.id && e[2] === 'edge'), 'riding off the arena is a knockout');
}

// ---- bots keep the arena from ever being empty ----
{
  const a = arena({bots: true});
  for (let i = 0; i < 60; i++) a.step();
  // Bots ride into each other like anyone else, and the top-up only adds one every five ticks, so the
  // count at any single tick is a coin toss - asking for exactly six here failed about one run in
  // seventy. Measured over 20,000 ticks: six 98.6% of the time, five 1.3%, four 0.05%, never seven and
  // never below four. So watch a window and check the shape: it fills to six, never grows past it, and
  // is never left near-empty while the replacements come back.
  let max = 0, min = Infinity;
  for (let i = 0; i < 100; i++) {
    a.step();
    max = Math.max(max, a.bikes.size);
    min = Math.min(min, a.bikes.size);
  }
  is(max, 6, 'bots top the arena up to six bikes, and never past six');
  assert(min >= 3, 'and it is never left near-empty between knockouts (thinnest was ' + min + ')');
  assert([...a.bikes.values()].every(b => b.bot), 'and they are all bots when nobody has joined');
}

// ---- a launch-day surge: the arena seats twelve and turns the thirteenth away ----
// The cap is the one arena rule a link that does better than expected is guaranteed to hit, and it
// had no check at all. Three things have to hold or a surge goes wrong for everyone at once: the cap
// is really a cap, being turned away is SAID rather than left silent on "connecting...", and a seat
// that frees up is handed to the next rider instead of staying shut.
{
  const a = arena();
  const joiner = name => {
    const got = [];
    const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
    a.socks.add(s);
    a.onMsg(s, JSON.stringify({t: 'join', name}));
    // spawn picks its spot at random and can come up empty on a busy board; the live server retries
    // every tick, so retry here too rather than letting a random miss read as a broken cap. A rider
    // who was turned away never gets a waiting flag, so this never papers over the cap itself.
    for (let i = 0; i < 200 && s.waiting !== undefined; i++) a.trySpawn(s);
    return {s, said: () => got.map(m => m.t)};
  };
  const seated = [];
  for (let i = 1; i <= 12; i++) seated.push(joiner('P' + i));
  is(a.bikes.size, 12, 'twelve riders all get a bike');
  assert(seated.every(j => j.said().includes('you')), 'and every one of them is told where they were dropped');

  const turned = joiner('P13');
  assert(turned.said().includes('full'), 'the thirteenth is told the arena is full, not left on "connecting"');
  assert(!turned.s.bike, 'and is given no bike');
  is(a.bikes.size, 12, 'so the cap holds');

  // The refusal has to carry the number the referee counted, because the menu's own rider count is
  // asked over /count every 20s and is that stale by the time anyone presses Start. Measured against a
  // full local arena on 2026-10-01: the page read "11 riders in the arena now" directly above "arena is
  // full" - it told the player there was room and then refused them, which reads as a broken page on
  // the one day the link gets a crowd. One message, one number, so both lines on the menu agree.
  const refusal = [...(() => { const got = []; const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null,
    count: 0, windowAt: Date.now(), idle: 0}; a.socks.add(s); a.onMsg(s, JSON.stringify({t: 'join', name: 'P15'}));
    return got; })()].find(m => m.t === 'full');
  assert(refusal, 'a fifteenth rider is turned away too');
  is(refusal.on, 12, 'and the refusal says how many are riding, so the menu cannot contradict it');

  a.drop(seated[0].s);
  is(a.bikes.size, 11, 'a rider leaving takes their bike with them');
  assert(joiner('P14').said().includes('you'), 'and the seat that frees up goes to the next rider');
}

// ---- a surge that all asks on the SAME tick still cannot overshoot the cap ----
// The check above seats its riders one at a time, so each one's wait for room is over before the next
// asks. A real link that works turns up a dozen people in the same second, and on a crowded board
// spawn() legitimately comes up empty for a tick or two while step() retries - so the sockets already
// let in are riders in all but the bike. Counting only bikes meant every one of them was under the
// cap when it asked, and the arena quietly ended up busier than the number on it says.
{
  const a = arena();
  const joiner = name => {
    const got = [];
    const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
    a.socks.add(s);
    a.onMsg(s, JSON.stringify({t: 'join', name}));
    for (let i = 0; i < 200 && s.waiting !== undefined; i++) a.trySpawn(s);
    return {s, said: () => got.map(m => m.t)};
  };
  for (let i = 1; i <= 11; i++) joiner('P' + i);
  is(a.bikes.size, 11, 'eleven riders are seated with one seat left');

  // the board is momentarily too crowded to place anybody - a real state, not a broken spawn
  const room = a.spawn.bind(a);
  a.spawn = () => null;
  const late = [];
  for (let i = 1; i <= 5; i++) {
    const got = [];
    const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
    a.socks.add(s);
    a.onMsg(s, JSON.stringify({t: 'join', name: 'L' + i}));
    late.push({s, said: () => got.map(m => m.t)});
  }
  is(late.filter(j => j.s.waiting !== undefined).length, 1, 'only one of five is let in for the last seat');
  is(late.filter(j => j.said().includes('full')).length, 4,
    'and the other four are told the arena is full rather than left waiting for a seat that is taken');

  a.spawn = room;   // room opens up, and step() hands it to whoever is still waiting
  for (const s of a.socks) a.trySpawn(s);
  const humans = [...a.bikes.values()].filter(b => !b.bot).length;
  is(humans, 12, 'so the arena holds at the cap instead of overshooting it');
  assert(late.filter(j => j.s.bike).length === 1, 'exactly one of the five late riders got a bike');
}

// ---- bots step aside as people arrive, one at a time ----
// The promise is "join any time": a full house of bots must not keep a person out, and the arena must
// settle back to six bikes rather than growing every time someone joins.
{
  const a = arena({bots: true});
  for (let i = 0; i < 60; i++) a.step();
  assert(a.bikes.size >= 5 && [...a.bikes.values()].every(b => b.bot),
    'the arena starts as a full house of bots');   // a hair short is fine and is checked above
  for (let i = 1; i <= 3; i++) {
    const s = {ws: {send() {}}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
    a.socks.add(s);
    a.onMsg(s, JSON.stringify({t: 'join', name: 'P' + i}));
  }
  // Nothing steers these three and nothing steers the bots, so bikes are knocked out at random all the
  // way through - "exactly six bikes right now" is a coin toss, and asking for it failed about one run
  // in thirty. What actually has to hold is the shape of it: the arena comes back down off nine within
  // a second, never climbs past six again, keeps topping itself back up, and never bumps a person.
  let settled = -1, grew = 0, refilled = false;
  for (let i = 0; i < 80; i++) {
    a.step();
    if (settled < 0) { if (a.bikes.size <= 6) settled = i; }
    else if (a.bikes.size > 6) grew++;
    if (settled >= 0 && a.bikes.size === 6) refilled = true;
  }
  assert(settled >= 0 && settled < 10, 'the arena comes back down to six within a second of three people joining (' + settled + ')');
  is(grew, 0, 'and never grows past six again');
  assert(refilled, 'bots keep topping it back up to six as bikes are knocked out');
  const people = new Set(a.feed.flatMap(m => m.n || []).filter(n => !n[2]).map(n => n[0]));
  is(people.size, 3, 'all three people got a bike, full house of bots or not');
  is(events(a).filter(([id, , r]) => r === 'left' && people.has(id)).length, 0,
    'and it is bots that gave way - nobody was ever bumped to make room');
}

// ---- a bot with the blade out does not ride into the pocket it is sealing ----
// Half of every knockout in the arena used to be a bot hitting its own blade. The cause: the flood
// fill that picks a bot's turn read the cell the bot was standing on as open floor, even though the
// blade was about to lay a barricade on it that same tick - so a dead end still joined to the rest of
// the arena through the bot itself looked like all the room in the world. Board here (W is 40): the
// bot sits in the only gap between a five-cell dead end straight ahead and a thirty-cell field to its
// right. Straight ahead also carries the go-straight bonus, so before the fix it won and the bot
// walled itself in.
{
  const a = arena({bots: true});
  const b = a.spawn('', true);
  const rnd = Math.random;
  Math.random = () => 0.5;                     // no slip, no noise: one board, one answer
  try {
    a.owner.fill(-1);                          // every cell a wall, then carve out just this test's board
    const open = (x, y) => { a.owner[y * 40 + x] = 0; };
    open(10, 10);                              // where the bot stands
    for (let y = 5; y <= 9; y++) open(10, y);            // the dead end: 5 cells, reachable only through the bot
    for (let y = 10; y <= 12; y++) for (let x = 11; x <= 20; x++) open(x, y);   // the open field: 30 cells
    Object.assign(b, {x: 10, y: 10, dir: 'U', want: true, blade: true, bladeFor: 0});
    a.think(b);
    is(b.dir, 'R', 'it turns into the open field instead of the dead end it is closing');
    is(a.owner[10 * 40 + 10], 0, 'and the board is left exactly as it found it');
  } finally { Math.random = rnd; }
}

// ---- hearing about it when something breaks ----
// The one endpoint a stranger can write to, so everything it accepts is checked here, and so is the
// thing that would actually cost money: none of it may start the tick.
{
  const a = arena();
  const post = body => a.say(new Request('http://x/say', {method: 'POST', body,
    headers: {'content-type': 'text/plain', 'user-agent': 'TestPhone/1.0'}}));
  const notes = () => a.runs.filter(r => r[0] === 'say' || r[0] === 'err');

  is((await post(JSON.stringify({kind: 'say', name: 'LOK', body: 'blade is under my thumb'}))).status, 200,
    'a player can say what broke');
  is(notes()[0][3], 'TestPhone/1.0', 'and the server writes down what they were riding on');
  is((await post(JSON.stringify({kind: 'err', body: 'boom @ index.html:12'}))).status, 200,
    'the page can report its own crash');
  is(notes()[1][0], 'err', 'and it is filed as a crash, not as a note');
  await post(JSON.stringify({kind: 'nonsense', body: 'x'}));
  is(notes()[2][0], 'say', 'anything else is filed as a note rather than trusted');

  await post(JSON.stringify({name: 'AVERYLONGNAME', body: 'y'.repeat(900)}));
  is(notes()[3][1].length, 8, 'a long name is cut to the eight a rider gets');
  is(notes()[3][2].length, 600, 'and a long note is cut rather than refused');

  is((await post(JSON.stringify({body: '   '}))).status, 400, 'an empty note is refused');
  is((await post('not json')).status, 400, 'and so is junk');
  is(notes().length, 4, 'neither wrote anything down');

  for (let i = 0; i < 30; i++) await post(JSON.stringify({body: 'flood'}));
  is((await post(JSON.stringify({body: 'flood'}))).status, 429, 'a flood is turned away after 30 in a minute');

  is(a.timer, null, 'and none of it started the arena ticking, which is what would cost money');
}

// ---- a socket left with no bike gets hung up on, so nobody can hold the tick open for free ----
// This is the cost guard: a phone that drops off the network never sends a close, and without this
// the arena would tick ten times a second for it until Cloudflare noticed.
{
  const a = arena();
  const closed = [];
  const sock = name => { const s = {ws: {send() {}, close: () => closed.push(name)}, bike: null, count: 0, windowAt: Date.now(), idle: 0}; a.socks.add(s); return s; };
  const ghost = sock('ghost'), queued = sock('queued');
  queued.waiting = 'Q'; a.spawn = () => null;   // no room, so this one really is still waiting to ride
  for (let i = 0; i < 300; i++) a.step();
  assert(a.socks.has(ghost), 'a bikeless socket is left alone for 30s');
  a.step();
  assert(!a.socks.has(ghost) && closed.includes('ghost'), 'and hung up on just after');
  assert(a.socks.has(queued), 'a socket still waiting for room to ride is never hung up on');

  const b = new (a.constructor)({storage: {sql: {exec: () => []}}});
  const lone = {ws: {send() {}, close() {}}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
  b.socks.add(lone); b.start();
  for (let i = 0; i < 301; i++) b.step();
  is(b.socks.size, 0, 'when that was the last socket in the arena');
  is(b.timer, null, 'the tick stops, so the bill stops with it');
}

// ---- a turn the arena does not recognise is dropped, including the ones every object answers to ----
// The other half of the same cost guard, and the nastier half: a rider holding a LIVE bike. The turn
// check is a lookup in DIRS, and a plain object answers for 'constructor', '__proto__', 'toString' and
// the rest of Object.prototype - so one line in any player's console used to set a real bike's heading
// to a word, which sent it to NaN,NaN on the next tick. Nothing threw: every edge and collision test
// compares against NaN and comes back false, so the bike could not die, never freed its seat, and kept
// its socket out of the idle hang-up above - the arena ticked on for a rider nobody could see, and the
// whole board was broadcast a bike at null,null. Checked at the gate and again after the tick.
{
  const a = arena();
  const junk = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'X', 'u'];
  for (const d of junk) {
    const {b, say} = rider(a, 'J', 10, 30, 'R');
    say({t: 'turn', d});
    is(b.queue.length, 0, 'a turn of ' + JSON.stringify(d) + ' never reaches the queue');
    a.bikes.delete(b.id); a.socks.delete(b.sock);
  }
  const {b, say} = rider(a, 'LOK', 10, 10, 'R');
  say({t: 'turn', d: 'constructor'});
  for (let i = 0; i < 5; i++) a.step();
  is(b.dir, 'R', 'the bike keeps the heading it had');
  assert(Number.isInteger(b.x) && Number.isInteger(b.y), 'and is still on a real cell, not NaN (' + b.x + ',' + b.y + ')');
  is(b.x, 15, 'having ridden on exactly as if nothing was said');
  const sent = a.feed[a.feed.length - 1].b.flat();
  assert(sent.every(v => typeof v === 'number'), 'and no rider is sent a bike at null,null');
  // the real cost of the old bug: a bike that cannot die holds its seat and its socket for ever
  for (let i = 0; i < 400; i++) a.step();
  assert(!b.alive, 'a bike that is told nonsense still dies at the edge like any other');
}

// ---- clearing the board ----
// The only way a bad run ever comes off the board, so both halves are checked: the door, and the delete.
{
  const worker = (await import('./src/index.js')).default;
  const reached = [];
  const env = {ADMIN: 'sekrit', ARENA: {idFromName: () => 1, get: () => ({fetch: r => { reached.push(r.url); return new Response('in'); }})}};
  const door = u => worker.fetch(new Request(u), env);
  is((await door('http://x/board')).status, 403, 'no key, no board');
  is((await door('http://x/board?key=wrong')).status, 403, 'and the wrong key is no better');
  is((await door('http://x/board?key=sekrit')).status, 200, 'the ADMIN secret gets in');
  is((await worker.fetch(new Request('http://x/board?key=sekrit'), {ARENA: env.ARENA})).status, 403,
    'and with no secret set nobody gets in, rather than everybody');
  is(reached.length, 1, 'only the one allowed request ever reached the arena');

  // a list of rows standing in for the table, so the deletes can actually be seen to happen
  const a = arena();
  let rows = [{day: '2026-09-20', name: 'TEST', score: 7, secs: 7, kos: 0, at: 1},
              {day: '2026-09-20', name: 'LOK', score: 40, secs: 30, kos: 1, at: 2}];
  a.sql.exec = (q, ...args) => {
    if (/^DELETE/.test(q)) rows = args.length ? rows.filter(r => r.name !== args[0]) : [];
    return /^SELECT/.test(q) ? rows : [];
  };
  const board = (method, qs = '') => a.fetch(new Request('http://x/board' + qs, {method}));
  is((await (await board('GET')).json()).length, 2, 'a plain read lists the runs and removes nothing');
  is((await board('POST')).status, 400, 'a POST that asks for nothing in particular is refused');
  is(rows.length, 2, 'and it left the board alone');
  is((await (await board('POST', '?name=TEST')).json()).length, 1, 'one rider can be taken off');
  is(rows[0].name, 'LOK', 'and it is the right one that is left');
  is((await (await board('POST', '?wipe=1')).json()).length, 0, 'or the whole board can be emptied');
  is(a.timer, null, 'and none of it started the arena ticking');
}

// ---- the checklist's own notes come off the player inbox, and the player reports do not ----
// This list files one note of its own on every single run, so by launch morning the inbox is mostly
// its own test notes with the real reports buried underneath. Real SQLite rather than a stand-in
// list, because the part that is easy to get wrong is that the delete has to match the name as the
// table actually STORED it - cut to 8 characters, so PREFLIGH and not PREFLIGHT.
{
  const a = arena({board: true});
  const say = (name, body) => a.fetch(new Request('http://x/say',
    {method: 'POST', body: JSON.stringify({name, body})}));
  const inbox = (method, qs = '') => a.fetch(new Request('http://x/inbox' + qs, {method}));
  is((await say('PREFLIGHT', 'checklist, ignore')).status, 200, 'the checklist files a note');
  is((await say('LOK', 'the blade sticks on my phone')).status, 200, 'and a player files a real one');
  is((await (await inbox('GET')).json()).length, 2, 'a plain read lists both and removes nothing');
  is((await inbox('POST')).status, 400, 'a POST that names nobody is refused');
  is((await (await inbox('GET')).json()).length, 2, 'and it left the inbox alone');
  const left = await (await inbox('POST', '?name=PREFLIGH')).json();
  is(left.length, 1, 'the checklist notes come off under the name the table really stored');
  is(left[0] && left[0].name, 'LOK', 'and it is the player report that is left');
  is((await (await inbox('POST', '?name=NOBODY')).json()).length, 1, 'a name nobody wrote under deletes nothing');
  is(a.timer, null, 'and none of it started the arena ticking');
}

// ---- a rider who leaves the name box empty is announced by the name the board will use ----
{
  const a = arena();
  const s = {ws: {send() {}}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
  a.socks.add(s);
  a.onMsg(s, JSON.stringify({t: 'join', name: ''}));
  a.step();
  const id = s.bike && s.bike.id, told = a.feed.flatMap(m => m.n || []).find(([i]) => i === id);
  is(told && told[1], 'RIDER' + id, 'everyone is told the nameless rider is RIDER' + id + ', not a blank');
}

// ---- a name the board cannot keep is said out loud, not rubbed out in silence ----
// The page, not the referee, is what a player types into, so the rule lives in index.html - lifted
// out here so it cannot quietly go back to erasing the box and riding as RIDER7.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const expr = page.match(/raw\.normalize\('NFD'\)[\s\S]*?\.slice\(0, 8\)/);
  assert(!!expr, 'the page folds a typed name before it strips it');
  const clean = expr ? new Function('raw', 'return ' + expr[0]) : () => '';
  is(clean('José'), 'JOSE', 'an accent rides as the plain letter rather than losing the letter');
  is(clean('Zoë'), 'ZOE', 'and so does a diaeresis');
  is(clean('l0k!'), 'L0K', 'punctuation still goes, digits still stay');
  is(clean('小明'), '', 'a name in another script has nothing the board can keep');
  assert(/if \(!n && raw\.trim\(\)\)/.test(page),
    'so the page stops and says so instead of starting a run as RIDERn');
}

// ---- a rider is told WHERE they were dropped, not just that they are riding ----
// The page hides the menu the instant 'you' lands. With only an id in it, the page had no bike to point
// the camera at until the next tick, so every run opened on the whole arena at menu zoom and then snapped.
{
  const a = arena();
  const got = [];
  const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
  a.socks.add(s);
  a.onMsg(s, JSON.stringify({t: 'join', name: 'LOK'}));
  const you = got.find(m => m.t === 'you');
  assert(you && you.b, 'the rider is told where they were dropped, before any tick has run');
  assert(you && you.b && you.b.join() === a.pack(s.bike).join(), 'and it is the same packed bike the broadcast uses');
}

// ---- the board: the one permanent record the game leaves behind ----
// Everything else in the arena lasts eight seconds. The board is what a player comes back for and what
// the game gets judged by on day one, and nothing checked it at all - the stand-in SQL handle the other
// sections use swallows every write and answers every read with nothing. A wrong board is silent: the
// runs still happen, the menu still fills, and only the numbers on it are wrong.
const TODAY = new Date().toISOString().slice(0, 10);
// one run start to knockout: dropped y0 rows down and riding straight into the bottom edge, so the run
// lasts exactly (60 - y0) ticks and the score it should earn is arithmetic rather than a guess
function ride(a, name, y0, kos = 0) {
  const {b} = rider(a, name, 20, y0, 'D');
  b.kos = kos;
  for (let i = 0; i < 70 && b.alive; i++) a.step();
  return b;
}
{
  const a = arena({board: true});
  const b = ride(a, 'LOK', 2, 2);
  assert(!b.alive, 'the run ended');
  const rows = a.top(null), row = rows[0] || [];
  is(rows.length, 1, 'the referee writes the run down the moment it ends');
  is(row[0], 'LOK', 'under the rider who rode it');
  is(row[1], 25, 'score is a point a second alive plus ten a knockout (5.8s, 2 KOs)');
  is(row[2], 5.8, 'the seconds are kept to a tenth');
  is(row[3], 2, 'and so are the knockouts');
}

// A run worth nothing is not worth a row. There is no way for a player to take one off again, so the
// board would otherwise silt up with half-second hangups.
{
  const a = arena({board: true});
  ride(a, 'LOK', 55);
  is(a.top(null).length, 0, 'a run worth nothing never reaches the board');
}

// Bots ride the same arena and are scored the same way inside it; one of them out-scoring the people
// on the menu board would be the first thing anyone noticed on day one.
{
  const a = arena({board: true, bots: true});
  const bot = a.spawn('', true);
  a.spawn = () => null;      // no more bots, and
  a.think = () => {};        // this one rides where the check puts it rather than where it fancies
  Object.assign(bot, {x: 20, y: 2, dir: 'D', queue: []});
  for (let i = 0; i < 70 && bot.alive; i++) a.step();
  assert(!bot.alive, 'the bot rode into the edge after a run worth five');
  is(a.top(null).length, 0, 'a bot never lands on the board, however long it rides');
}

// The board shows each rider's BEST run, so one bad night does not bury a good one - and the row has
// to be that one run whole. The query takes the seconds and the knockouts from the best row by a SQLite
// rule about bare columns beside MAX(); if that ever stopped holding, the board would quietly show one
// run's score next to another run's time and nobody could say why their row looked wrong.
{
  const a = arena({board: true});
  ride(a, 'LOK', 30);        // 3.0s, no knockouts -> 3
  ride(a, 'LOK', 45, 3);     // 1.5s, 3 knockouts  -> 31, the best
  ride(a, 'LOK', 2);         // 5.8s, no knockouts -> 5
  const rows = a.top(null), row = rows[0] || [];
  is(rows.length, 1, 'three runs under one name leave one row: no rider can fill the board');
  is(row[1], 31, 'and it is their best run, not their last');
  is(row[2], 1.5, 'with that same run seconds beside it');
  is(row[3], 3, 'and that same run knockouts');
}

// Today and All time are two different boards. Yesterday's runs showing under Today would make the
// arena look busier than it is; today's run missing from it hides the thing a player just did.
{
  const a = arena({board: true});
  a.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)', '2026-01-01', 'OLD', 500, 50.0, 0, 1);
  ride(a, 'LOK', 2);
  const day = a.top(TODAY), all = a.top(null);
  is(day.length, 1, 'Today holds only the runs ridden today');
  is(day[0] && day[0][0], 'LOK', 'which is the rider who rode today');
  is(all.length, 2, 'All time holds both');
  is(all[0] && all[0][0], 'OLD', 'best first, whatever day it was ridden');
}

// ten rows is what the menu has room for, and an unbounded list would only grow with the game
{
  const a = arena({board: true});
  for (let i = 0; i < 14; i++)
    a.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)', TODAY, 'R' + i, 100 - i, 10.0, 0, i);
  const rows = a.top(TODAY);
  is(rows.length, 10, 'the board stops at ten');
  is(rows[0][0], 'R0', 'highest score first');
  is(rows[9][0], 'R9', 'down to the tenth best');
}

// Road at the drop. A rider who presses Start and then spends a second working out which way they are
// pointing must not be dead before they have touched a control - that is the first thing a launch-day
// visitor sees, and it reads as the game's fault, not theirs. The arena is 60 tall, so five seconds of
// road is always available somewhere; the rule is that the search actually goes out and finds three.
// Measured into the crowded board a real arena is, with every bot laying wall.
{
  const STEP = {U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]};
  const road = (a, b) => {   // uncapped, unlike the referee's own room(), which stops once it has enough
    let n = 0;
    for (let k = 1; k < 200; k++) {
      const nx = b.x + STEP[b.dir][0] * k, ny = b.y + STEP[b.dir][1] * k;
      if (nx < 0 || ny < 0 || nx >= 40 || ny >= 60 || a.owner[ny * 40 + nx]) break;
      n++;
    }
    return n;
  };
  let worst = Infinity, thin = 0, nulls = 0;
  for (let i = 0; i < 120; i++) {
    const a = arena({bots: true});
    for (let k = 0; k < 6; k++) { const bot = a.spawn('', true); if (bot) bot.want = true; }   // blades out
    for (let t = 0; t < 60; t++) a.step();
    const b = a.spawn('LOK', false);
    if (!b) { nulls++; continue; }
    const r = road(a, b);
    worst = Math.min(worst, r);
    if (r < 25) thin++;
  }
  is(nulls, 0, 'a crowded arena still finds room for everyone who asks (0 turned away)');
  assert(worst >= 18, 'nobody is dropped with under 1.8s of road in front of them (worst ' + (worst / 10) + 's)');
  assert(thin <= 12, 'and under a tenth get less than 2.5s (' + thin + ' of 120)');
}

// ---- ten minutes of a busy arena, with the page watching ----
// Every check above sets up one situation and looks at it. This one just runs the arena hard for ten
// simulated minutes - people arriving faster than seats come free, riders steering and swinging the
// blade, bots filling the gaps - and holds it to the rules on every one of the six thousand ticks.
// The last pair is the point of it: a desync is silent, and the first anyone hears is a player dying
// on a wall that was not on their screen. So the broadcast is replayed through the PAGE's own wall
// bookkeeping, line for line out of index.html, and compared to the referee's cell by cell.
// Seeded, so a failure here comes back the same way next time.
{
  let seed = 20261001;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = n => Math.floor(rnd() * n);
  const realRandom = Math.random;
  Math.random = rnd;   // where the arena drops riders and how the bots ride, seeded along with everything else
  const a = arena({bots: true});
  const STEP = {U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]}, DIRS = ['U', 'D', 'L', 'R'];
  const page = {walls: new Map(), bikes: new Map()};
  const socks = new Set();
  let read = 0, joined = 0, seated = 0, turned = 0, orphan = 0, offBoard = 0, shared = 0,
      over = 0, wallDiff = 0, bikeDiff = 0, threw = null, peak = 0;

  for (let t = 1; t <= 6000 && !threw; t++) {
    if (rnd() < 0.4) {
      let full = false;
      const s = {ws: {send: m => { if (JSON.parse(m).t === 'full') full = true; }, close() {}},
        bike: null, count: 0, windowAt: Date.now(), idle: 0};
      a.socks.add(s); joined++;
      a.onMsg(s, JSON.stringify({t: 'join', name: 'P' + joined}));
      if (full) { a.socks.delete(s); turned++; } else { socks.add(s); seated++; }
    }
    if (rnd() < 0.01 && socks.size) { const s = [...socks][pick(socks.size)]; a.drop(s); socks.delete(s); }
    for (const s of socks) {
      const b = s.bike;
      if (!b || !b.alive) continue;
      const free = (d, k) => {
        for (let i = 1; i <= k; i++) {
          const x = b.x + STEP[d][0] * i, y = b.y + STEP[d][1] * i;
          if (x < 0 || y < 0 || x >= 40 || y >= 60 || a.owner[y * 40 + x]) return false;
        }
        return true;
      };
      if (!free(b.dir, 5)) {
        const open = DIRS.filter(d => free(d, 6));
        if (open.length) a.onMsg(s, JSON.stringify({t: 'turn', d: open[pick(open.length)]}));
      }
      if (rnd() < 0.08) a.onMsg(s, JSON.stringify({t: 'blade', on: rnd() < 0.6}));
    }
    try { a.step(); } catch (e) { threw = e; break; }

    const live = [...a.bikes.values()], ids = new Set(live.map(b => b.id)), cells = new Set();
    for (const b of live) {
      if (b.x < 0 || b.y < 0 || b.x >= 40 || b.y >= 60) offBoard++;
      if (cells.has(b.y * 40 + b.x)) shared++;
      cells.add(b.y * 40 + b.x);
    }
    const humans = live.filter(b => !b.bot).length;
    peak = Math.max(peak, humans);
    if (humans > 12) over++;
    for (let c = 0; c < a.owner.length; c++) if (a.owner[c] && !ids.has(a.owner[c])) { orphan++; break; }

    // index.html, onMsg: lay what arrived, drop a knocked-out rider's walls, then let the old ones go
    for (; read < a.feed.length; read++) {
      const m = a.feed[read];
      if (m.t !== 'k') continue;
      for (const [c, o] of m.a || []) page.walls.set(c, {o, born: m.k});
      for (const id of m.c || []) for (const [c, w] of page.walls) if (w.o === id) page.walls.delete(c);
      for (const [c, w] of page.walls) if (w.born + 80 <= m.k) page.walls.delete(c);
      page.bikes = new Map((m.b || []).map(b => [b[0], b]));
    }
    let n = 0;
    for (let c = 0; c < a.owner.length; c++) if (a.owner[c]) {
      n++;
      const w = page.walls.get(c);
      if (!w || w.o !== a.owner[c]) wallDiff++;
    }
    if (n !== page.walls.size) wallDiff++;
    if (page.bikes.size !== live.length) bikeDiff++;
    else for (const b of live) { const p = page.bikes.get(b.id); if (!p || p[1] !== b.x || p[2] !== b.y) { bikeDiff++; break; } }
  }

  Math.random = realRandom;
  assert(!threw, 'the arena runs ten minutes under load without throwing' + (threw ? ' (' + threw.message + ')' : ''));
  is(offBoard, 0, 'no bike is ever left off the board');
  is(shared, 0, 'and no two bikes ever share a cell');
  is(over, 0, 'the twelve-rider cap holds on every tick (' + seated + ' seated, ' + turned + ' turned away, peak ' + peak + ')');
  is(orphan, 0, 'no wall outlives the rider who laid it');
  is(wallDiff, 0, 'the page and the arena agree on every wall, every tick');
  is(bikeDiff, 0, 'and on where every bike is');
  assert(a.runs.length > 50, 'runs were written down throughout (' + a.runs.length + ')');
  is(a.runs.filter(([, , score, secs, kos]) => score <= 0 || Math.floor(secs) + 10 * kos !== score).length, 0,
    'and every one of them scores its own seconds and knockouts');
}

// ---- the camera stays inside the arena, and the phone's camera is left exactly where it was ----
// Drawing lives only in index.html, so the rule is lifted out of it here. Measured 2026-10-01 on a
// 1920x1080 computer BEFORE this: 29% of the screen was black nothing in the middle of the board, 50%
// riding along a wall and 71% in a corner - the arena is 40 cells wide and the 34-cell zoom cap, written
// for a phone where it never binds, could not stretch it across a 16:9 screen at any camera position.
// The phone half of this is the part that must not move: the rider is held at 40% down the screen so the
// pad and the BLADE button never sit on top of him, and that is checked below cell by cell, not asserted.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const cellExpr = page.match(/Math\.max\(14, Math\.min\(cw \/ W, ch \/ 18\)[^\n]*?ch \/ 26\)\)\)/);
  const holdExpr = page.match(/\(want, screen, board, top = 0\) =>[\s\S]*?Math\.max\(screen - board, want\)\)/);
  const hudExpr = page.match(/const HUD_H = (\d+);/);
  assert(!!cellExpr, 'the page sizes a cell so the board can span the width');
  assert(!!holdExpr, 'and holds the camera inside the arena');
  assert(!!hudExpr, 'and knows how much room the HUD needs');
  const W = 40, H = 60, HUD = hudExpr ? +hudExpr[1] : 0;
  const cell = cellExpr ? new Function('cw', 'ch', 'W', 'H', 'return ' + cellExpr[0]) : () => 0;
  const hold = holdExpr ? new Function('return ' + holdExpr[0])() : () => 0;
  const oldCell = (w, h) => Math.max(14, Math.min(34, Math.min(w / 18, h / 26)));

  // what the page draws, for one bike on one screen: [cell size, left edge, top edge]
  const shot = (w, h, touch, bx, by) => {
    const c = cell(w, h, W, H), camX = bx + 0.5, camY = by + 0.5;
    const wantY = (touch ? h * 0.40 : h / 2) - camY * c;
    return [c, hold(w / 2 - camX * c, w, W * c), touch ? wantY : hold(wantY, h, H * c, HUD)];
  };
  const sweep = (w, h, touch) => {
    let movedOnAPhone = 0, worstOutside = 0, underHud = 0, offScreen = 0;
    for (let bx = 0; bx < W; bx++) for (let by = 0; by < H; by++) {
      const [c, ox, oy] = shot(w, h, touch, bx, by);
      if (touch) {   // the phone: same zoom, same 40% down the screen, to the pixel
        const oc = oldCell(w, h);
        if (Math.abs(c - oc) > 1e-9 || Math.abs(oy - (h * 0.40 - (by + 0.5) * oc)) > 1e-9) movedOnAPhone++;
      }
      // screen edges showing nothing but the black outside the arena
      const out = Math.max(0, ox) + Math.max(0, w - (ox + W * c)) + Math.max(0, oy) + Math.max(0, h - (oy + H * c));
      worstOutside = Math.max(worstOutside, out);
      const sx = (bx + 0.5) * c + ox, sy = (by + 0.5) * c + oy;
      if (sx < 0 || sx > w || sy < 0 || sy > h) offScreen++;
      if (!touch && sy < HUD) underHud++;      // a rider hidden behind the score readout
    }
    return {movedOnAPhone, worstOutside, underHud, offScreen};
  };

  for (const [w, h] of [[375, 812], [375, 667], [360, 640], [414, 896], [320, 568], [768, 1024]])
    is(sweep(w, h, true).movedOnAPhone, 0, 'a phone at ' + w + 'x' + h + ' keeps the zoom and the 40% it always had');
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440], [1280, 800]]) {
    const r = sweep(w, h, false);
    const was = Math.max(...[[0, 0], [20, 0], [0, 30], [39, 59]].map(([bx, by]) => {
      const c = oldCell(w, h), ox = w / 2 - (bx + 0.5) * c, oy = h / 2 - (by + 0.5) * c;
      return Math.max(0, ox) + Math.max(0, w - (ox + W * c)) + Math.max(0, oy) + Math.max(0, h - (oy + H * c));
    }));
    is(+r.worstOutside.toFixed(6), HUD, 'a computer at ' + w + 'x' + h + ' shows no black past the arena but the '
      + HUD + 'px the HUD sits in (was up to ' + was.toFixed(0) + 'px)');
    is(r.underHud, 0, 'and never rides the bike in behind the HUD');
    is(r.offScreen, 0, 'and never off the screen altogether');
  }
  // the menu's whole-arena shot is the one place a board narrower than the screen is drawn: it must come
  // out centred, exactly where the arithmetic it replaced put it
  for (const [w, h] of [[375, 812], [1920, 1080]]) {
    const c = Math.min(w * 0.94 / W, h * 0.82 / H);
    is(+hold(w / 2 - (W / 2) * c, w, W * c).toFixed(6), +(w / 2 - (W / 2) * c).toFixed(6),
      'the menu arena is still centred sideways at ' + w + 'x' + h);
    is(+hold(h / 2 - (H / 2) * c, h, H * c).toFixed(6), +(h / 2 - (H / 2) * c).toFixed(6), 'and up and down');
  }
}

// ---- every bike in the arena has its own name ----
// The HUD's rider list is drawn by NAME, not by id, so two bots called FLUX are two identical rows in
// front of the player. Bot names went by id % 10 and ids climb for ever, so the list came round again
// while the earlier bot of that name was still riding: measured 736 of 6000 ticks in one run and 1092 in
// another, first about two minutes in. Watch a long window rather than one tick, because it takes a few
// knockouts to show up at
// all - the old rule passed any check that only looked at the first six bots.
{
  const a = arena({bots: true});
  let dupTicks = 0, worst = null;
  for (let i = 0; i < 6000; i++) {
    a.step();
    const names = [...a.bikes.values()].map(b => b.name);
    if (new Set(names).size !== names.length) { dupTicks++; if (!worst) worst = names.slice().sort().join(','); }
  }
  is(dupTicks, 0, 'no two bikes in the arena ever share a name over 6000 ticks'
    + (worst ? ' (saw ' + worst + ')' : ''));
}

// A bot must not take a name a HUMAN is already riding under either: the player's own row is picked out
// of that same list by matching the name, so a bot wearing it gets highlighted as 'you'.
{
  const a = arena({bots: true});
  const mine = a.spawn('FLUX', false);
  assert(mine && mine.name === 'FLUX', 'a rider may call themselves FLUX, which is also a bot name');
  for (let i = 0; i < 400; i++) { a.step(); if (!mine.alive) break; }
  is([...a.bikes.values()].filter(b => b.bot && b.name === 'FLUX').length, 0,
    'and no bot ever rides under the name that rider is using while they are in the arena');
}

// The bot dedupe above closes the common way two rows read the same, but not the last one: a rider who
// types a name a bot is ALREADY riding under keeps it, and so does the bot, which was named first. The
// live rider list carries no bike id - it is [name, score, botflag] - so the page cannot match on id.
// It can match on the flag, and a player is never a bot. Lifted out of index.html rather than restated.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pb = page.indexOf('function paintBoard');   // the LIVE rider list, not the menu board below it
  const mark = page.indexOf("? ' you' : ''", pb);
  const open = page.lastIndexOf('+ (', mark);   // the condition's own bracket, which holds brackets itself
  const cond = mark > 0 ? page.slice(open + 3, mark).trim() : '';
  assert(!!cond && cond.includes('names.get(me)'), 'the page picks the rider their own row out of the live list');
  const isYou = cond
    ? new Function('n', 'bot', 'me', 'names', 'return !!(' + cond + ')')
    : () => false;
  // the player is bike 7 riding as FLUX; bot 3 had the name first and keeps it
  const names = new Map([[7, {n: 'FLUX', bot: false}], [3, {n: 'FLUX', bot: true}]]);
  const top = [['FLUX', 44, 1], ['FLUX', 31, 0], ['VOLT', 12, 1]];
  const you = top.filter(([n, sc, bot]) => isYou(n, !!bot, 7, names));
  is(you.length, 1, 'exactly one row is highlighted when a bot shares the rider name');
  is(you.length === 1 && you[0][2], 0, 'and it is the rider, not the bot that was named first');
  is(top.filter(([n, sc, bot]) => isYou(n, !!bot, 7, new Map([[7, {n: 'VOLT', bot: false}]]))).length, 0,
    'and a rider whose name no live bike shares is not highlighted on a bot row');
}
console.log(bad ? '\n' + bad + ' FAILED' : '\nall good');
process.exit(bad ? 1 : 0);
