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

// ---- a press while the HUD still says "recharging" deploys anyway, and costs the lockout again ----
// The page dims the BLADE button and reads 'recharging' under 12% (LOW in index.html), on the stated
// grounds that under that the blade is not worth taking. The referee's gate is charge > 0, not LOW, so
// the press still fires - the HUD discourages it but nothing refuses it. Measured 2026-10-08: pressing
// at 2% buys ONE cell and restarts the full 1s lockout, which leaves the blade unusable 1.2s longer than
// not pressing at all (1.8s if pressed at 8%). Whether to gate it at LOW is a feel call and Lok's, so
// this pins what the rule does TODAY: if a later session "finishes" the LOW fix by moving the gate, the
// first line here flips rather than the game changing in silence.
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 2, 2, 'R');
  const ride = () => { if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'});
    else if (b.dir === 'D' && b.y >= 57) say({t: 'turn', d: 'L'}); a.step(); };
  say({t: 'blade', on: true});
  // both loops are capped: a charge rule that never empties, or never climbs again, should fail this
  // check on the line below rather than hang the whole suite with nothing to read
  for (let i = 0; i < 60 && a.pack(b)[5] !== 0; i++) ride();   // drain it dry
  for (let i = 0; i < 60 && a.pack(b)[5] === 0; i++) ride();   // and sit out the 1s lockout
  const charge = a.pack(b)[5], before = laid(a, b.id);
  assert(charge > 0 && charge < 12, 'the charge is back above zero but still under the HUD\'s own LOW (' + charge + '%)');
  say({t: 'blade', on: true});
  a.step();
  assert(b.blade, 'a press there still deploys - the referee gates on charge > 0, not on LOW');
  is(laid(a, b.id) - before, 1, 'and buys exactly one cell of wall before running dry again');
  is(b.gap, 10, 'then the full 1s lockout starts over, on the same tick');
  is(a.pack(b)[5], 0, 'with the charge back at zero');
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

// ---- the game's own crash reports cannot drown out a player typing into the box ----
// The thirty above are shared by everyone AND by both kinds, and the two kinds are not equals: a player
// sends one note deliberately, while the page's error reporter sends up to nine on its own with nobody
// asking. So four browsers the game throws on spend the whole minute between them, and everything after
// that is refused - including the player with something to say, who is shown "could not send, try again
// in a moment" and almost never does. Twenty of the thirty is the most the automatic half may take.
{
  const a = arena();
  const post = (kind, body) => a.say(new Request('http://x/say', {method: 'POST',
    body: JSON.stringify({kind, body}), headers: {'content-type': 'text/plain'}}));
  // the storm that used to silence everybody: four broken browsers' worth of automatic reports, which is
  // more than the single thirty could hold, arriving before the player has typed a word
  let through = 0;
  for (let i = 0; i < 36; i++) if ((await post('err', 'boom ' + i)).status === 200) through++;
  is(through, 20, 'the reports the page files by itself are held to twenty in a minute');
  is(a.runs.filter(r => r[0] === 'err').length, 20, 'so only twenty of them are written down');
  is((await post('err', 'and another')).status, 429, 'and every one after that is turned away');
  is((await post('say', 'the blade button does nothing on my phone')).status, 200,
    'while the player who meant to write still gets through, which is the whole point');
  is(a.runs.filter(r => r[0] === 'say').length, 1, 'and their note is on the list to be read');
  a.said.at -= 61000;
  is((await post('err', 'next minute')).status, 200, 'a new minute starts every tally over');
  // a player's own allowance is unchanged from the single pot it came out of: thirty in the minute
  a.said = {n: 0, say: 0, err: 0, at: Date.now()};
  let mine = 0;
  for (let i = 0; i < 31; i++) if ((await post('say', 'note ' + i)).status === 200) mine++;
  is(mine, 30, 'a player still has thirty of their own in a minute, exactly as before');
  // and the ceiling is what answers a real flood, which says 'say' like anything else would
  a.said = {n: 60, say: 0, err: 0, at: Date.now()};
  is((await post('say', 'past the ceiling')).status, 429,
    'a flood is stopped at the ceiling before its body is ever read');
  is(a.timer, null, 'none of which started the arena ticking either');
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
  // A socket still WAITING for a seat used to be exempt from the whole guard, and that was the one way
  // left for a bikeless socket to hold the arena - and the bill - open for ever. It protected nobody:
  // the page closes its own socket after 10s of not riding, and 300 ticks is 300 retries of trySpawn.
  assert(!a.socks.has(queued) && closed.includes('queued'), 'a socket the referee could not seat in 30s goes too');

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

// ---- a message that parses but is not an object is dropped, rather than thrown out of the handler ----
// The same gate as above, one step earlier. JSON.parse only throws on text that is not JSON, so the
// try/catch around it caught 'not json' and let 'null' straight through - and every branch of onMsg
// then reads m.t off it. Measured 2026-10-21 against a real wrangler dev arena before the guard went
// in: the sender's socket was closed with an abnormal 1006 and no reason, mid-run, which the page can
// only show as DISCONNECTED. The other rider in the arena kept every tick, so the arena itself was
// never at risk - but a live bike lost its seat to four bytes, and raw is the one thing here a
// stranger writes. Driven through onMsg exactly as the socket would deliver it, strings and all.
{
  const a = arena();
  const {b} = rider(a, 'LOK', 10, 10, 'R');
  const s = b.sock;
  for (const raw of ['null', '"turn"', '42', 'true', '[]']) {
    s.windowAt = Date.now();  s.count = 0;   // the flood guard counts per second, and this loop is faster
    let threw = null;
    try { a.onMsg(s, raw); } catch (e) { threw = String(e); }
    is(threw, null, 'raw ' + raw + ' is dropped rather than thrown out of the handler');
  }
  // an array answers for nothing onMsg asks about, so it must leave the bike exactly as it was
  s.windowAt = Date.now(); s.count = 0;
  a.onMsg(s, '[]');
  is(b.queue.length, 0, 'and none of them reaches the turn queue');
  for (let i = 0; i < 5; i++) a.step();
  is(b.dir, 'R', 'the bike keeps the heading it had');
  is(b.x, 15, 'having ridden on exactly as if nothing was said');
  assert(b.alive && a.socks.has(s), 'and the rider still has the seat the throw used to cost them');
}

// ---- the rules the turn gate itself enforces: no reversal, no no-op, and a queue that cannot flood ----
// The steering rule the whole game rests on, and it had never been checked. A reversal has to be
// refused or the blade makes the game unplayable: flip 180 with the blade out and the bike's next
// move is into the barricade it laid on the cell behind it, so one stray tap would be an instant
// death with nothing on screen to explain it.
{
  const a = arena();
  const {b, say} = rider(a, 'LOK', 20, 30, 'R');
  say({t: 'turn', d: 'L'});
  is(b.queue.length, 0, 'a straight reversal is refused at the door');
  say({t: 'turn', d: 'R'});
  is(b.queue.length, 0, 'and so is a tap for the heading the bike already has');
  say({t: 'turn', d: 'D'}); say({t: 'turn', d: 'L'}); say({t: 'turn', d: 'U'});
  is(b.queue.length, 2, 'the queue holds two taps and refuses the third');
  a.step();
  is(b.dir, 'D', 'so the bike takes the first tap, not the one it refused');
}

// ---- two turns inside one tick: one is taken, the other waits ----
// The reversal rule is enforced TWICE, against two different things, and nothing checked they agree.
// onMsg validates a tap against the TAIL OF THE QUEUE (the bike's heading only when it is empty);
// step() validates again against the bike's LIVE heading as it drains. Both are needed and neither is
// enough on its own: the gate cannot know what the heading will be two ticks from now, and the drain
// cannot know which tap the player made first. A player tapping down-then-left inside one 100ms tick
// passes the gate twice over, because L is not the reverse of D - so if step() ever drained the whole
// queue in one tick the bike would end that tick heading L one cell on from where it started, which
// is the cell it had just come from. With the blade out that is its own barricade. The `break` in the
// drain loop is the only thing standing there, so it is checked from all four headings and both ways round.
{
  const a = arena();
  const DELTA = {U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0]};
  for (const [d0, first, second] of [['R', 'D', 'L'], ['R', 'U', 'L'], ['L', 'D', 'R'], ['L', 'U', 'R'],
                                     ['U', 'L', 'D'], ['U', 'R', 'D'], ['D', 'L', 'U'], ['D', 'R', 'U']]) {
    const {b, say} = rider(a, 'LOK', 20, 30, d0);
    const behind = [20 - DELTA[d0][0], 30 - DELTA[d0][1]];   // the cell it rode in from
    say({t: 'turn', d: first});
    say({t: 'turn', d: second});
    is(b.queue.length, 2, d0 + ': both taps are held, ' + first + ' then ' + second);
    a.step();
    is(b.dir, first, d0 + ': the tick takes only the first tap');
    is(b.queue.length, 1, d0 + ': and the second is still waiting for the next tick');
    assert(b.x !== behind[0] || b.y !== behind[1],
      d0 + ': the bike never rides back into the cell it came from (' + b.x + ',' + b.y + ')');
    a.step();
    is(b.dir, second, d0 + ': the second tap lands one tick later');
    assert(b.x !== behind[0] || b.y !== behind[1], d0 + ': still clear of the cell behind it');
    a.bikes.delete(b.id); a.socks.delete(b.sock);
  }
}


// ---- the SAME turn rule is enforced in a THIRD place, and it is the one the player's thumb hits ----
// The two checks above are both the referee's: onMsg at the door, step() as the queue drains. The page
// keeps its own copy of the identical rule - no reversal, no tap for the heading you already have, and
// never more than two waiting - and refuses a tap before it ever reaches the wire. That copy is why
// steering feels instant, and it is also the one that can drift unnoticed: if the page let a tap
// through that the referee then refuses, the bike simply does not turn and nothing on screen says why,
// and if the page refuses one the referee would have taken, the player loses a turn they earned. Both
// are silent. So the page's own turn() is lifted out of index.html and asked the same question as the
// real referee for every heading, every queue it could be holding, and every tap.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = page.indexOf('function turn(d) {');
  const body = open > 0 ? page.slice(page.indexOf('{', open) + 1, page.indexOf('\n}', open)) : '';
  assert(body.includes('pend') && body.includes("send({t: 'turn'"),
    'the page keeps its own copy of the turn rule, refused before it reaches the wire');
  // does the PAGE put this tap on the wire? run its real body, with a stand-in for everything it touches
  const pageSends = (src, dir, queued, d) => {
    const run = new Function('ctx', 'd', 'with (ctx) {' + src + '}');
    const sent = [];
    run({riding: true, tick: 7, pendAt: 0, pend: [...queued], me: 1, bikes: new Map([[1, {d: dir}]]),
      BACK: {U: 'D', D: 'U', L: 'R', R: 'L'}, SFX: {turn() {}}, send: m => sent.push(m)}, d);
    return sent.length > 0;
  };
  // and would the REFEREE have queued it? the real onMsg, holding the same queue
  const refQueues = (dir, queued, d) => {
    const a = arena();
    const {b, say} = rider(a, 'LOK', 20, 30, dir);
    b.queue = [...queued];
    say({t: 'turn', d});
    return b.queue.length > queued.length;
  };
  const DD = ['U', 'D', 'L', 'R'];
  const everyCase = f => {
    const out = [];
    for (const dir of DD) for (const q of [[], ...DD.map(p => [p]), ...DD.flatMap(p => DD.map(r => [p, r]))])
      for (const d of DD) out.push(f(dir, q, d));
    return out;
  };
  const disagree = src => everyCase((dir, q, d) =>
    pageSends(src, dir, q, d) === refQueues(dir, q, d) ? null : dir + ' holding [' + q + '] tapped ' + d)
    .filter(Boolean);
  const drift = disagree(body);
  is(drift.length, 0, 'the page and the referee agree on every tap, from every heading, on every queue'
    + (drift.length ? ' - ' + drift.slice(0, 3).join('; ') : ' (' + everyCase(() => 1).length + ' cases)'));
  // the four rules named one at a time, so a failure above says which one moved
  is(pageSends(body, 'R', [], 'U'), true, 'a clean turn goes to the wire');
  is(pageSends(body, 'R', [], 'L'), false, 'a reversal never leaves the page');
  is(pageSends(body, 'R', [], 'R'), false, 'nor does a tap for the heading the bike already has');
  is(pageSends(body, 'R', ['U', 'L'], 'D'), false, 'and nor does a third tap on a full queue');
  // and the comparison CATCHES a drift rather than merely agreeing with today's code: break each rule
  // in the lifted copy in turn and the page must then be caught letting through what the referee refuses
  for (const [was, now, what] of [['d === BACK[last]', 'false', 'the reversal rule'],
                                  ['if (d === last) return true;', '', 'the no-op rule'],
                                  ['pend.length >= 2', 'false', 'the two-tap cap']])
    assert(body.includes(was) && disagree(body.replace(was, now)).length > 0,
      'dropping ' + what + ' from the page is caught by this check');
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
  // the name itself is picked to be free rather than to be the bike id (see the board section below),
  // so what matters here is that the arena announces the SAME one the board will file the run under
  assert(told && /^RIDER[0-9]{3}$/.test(told[1]), 'everyone is told a name, not a blank (' + (told && told[1]) + ')');
  is(told && told[1], s.bike && s.bike.name, 'and it is the name the board will file the run under');
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

// A blank name box is the launch-day default: it is empty for a first-time visitor, Start works
// without it, and the arena names those riders itself. That name used to be the bike id, and reset()
// puts nextId back to 1 every time the last socket goes - which right now is after nearly every run -
// so one anonymous rider after another was RIDER1. The board groups BY NAME and keeps the best score,
// so two strangers came back as ONE row: the one who scored less is not on the board at all, under a
// result screen that has just told them to look for their name on it.
{
  const a = arena({board: true});
  const one = ride(a, '', 2, 2);        // 5.8s + 2 KOs -> 25
  a.reset();                            // exactly what stop() does when the last socket goes
  const two = ride(a, '', 30);          // 3.0s, no knockouts -> 3
  assert(one.name !== two.name, 'two anonymous riders either side of a reset get different names');
  is(a.top(null).length, 2, 'so each of them keeps their own row on the board');
  assert(one.name.length <= 8, 'an assigned name fits the same 8 characters a typed one is cut to');
}

// And the name has to dodge the BOARD, not just the arena - the rider it would be merged with rode
// yesterday and is long gone. Deterministic on purpose: every name but one is already on the board, so
// a search that does not really read the board cannot pass this by luck.
{
  const a = arena({board: true});
  for (let i = 0; i < 900; i++)
    if (i !== 377) a.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)', TODAY, 'RIDER' + (100 + i), 1, 0.1, 0, i);
  const b = a.spawn('', false);
  is(b.name, 'RIDER477', 'the one name left on the board is the one the arena hands out');
}

// Past 900 the pool is spent, and 'the bike still gets a name' was never enough to ask. The old
// fallback was 'RIDER' + the bike id, and reset() puts ids back to 1 whenever the last socket goes -
// so two strangers either side of a reset were both RIDER1, and the board, which keeps the best run
// per NAME, showed the pair of them as one row with the loser missing. That is the same failure as
// the block above reached by a different road, and the road is the point: 900 anonymous riders have
// to have SCORED, not to be riding at once, and nothing ever prunes the board. Measured on this
// referee before the fix - two RIDER1s and one row. So the fallback has to be UNIQUE, not non-empty.
{
  const a = arena({board: true});
  for (let i = 0; i < 900; i++)
    a.sql.exec('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)', TODAY, 'RIDER' + (100 + i), 1, 0.1, 0, i);
  const one = ride(a, '', 2, 2);        // 25 points
  a.reset();                            // exactly what stop() does when the last socket goes
  const two = ride(a, '', 30);          // 3 points
  assert(one.name && two.name, 'with every three-digit name taken the riders still get one');
  assert(one.name !== two.name,
    'and two strangers either side of a reset still get different ones (' + one.name + ', ' + two.name + ')');
  assert(one.name.length <= 8 && two.name.length <= 8,
    'still inside the 8 characters a typed name is cut to (' + one.name + ', ' + two.name + ')');
  assert(!/^RIDER[0-9]{3}$/.test(one.name),
    'and it is not one of the three-digit names the board already holds (' + one.name + ')');
  is(a.top(TODAY).filter(r => r[0] === one.name || r[0] === two.name).length, 2,
    'so the board carries both of their runs rather than merging them into one');
  is(a.top(TODAY)[0] && a.top(TODAY)[0][1], 25, 'with the better run on top, as any other pair would be');
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
      over = 0, wallDiff = 0, bikeDiff = 0, threw = null, peak = 0,
      bytes = 0, bcasts = 0, snapBytes = 0;

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
      bytes += Buffer.byteLength(JSON.stringify(m));   // exactly what every rider's phone was sent
      bcasts++;
      for (const [c, o] of m.a || []) page.walls.set(c, {o, born: m.k});
      for (const id of m.c || []) for (const [c, w] of page.walls) if (w.o === id) page.walls.delete(c);
      for (const [c, w] of page.walls) if (w.born + 80 <= m.k) page.walls.delete(c);
      page.bikes = new Map((m.b || []).map(b => [b[0], b]));
    }
    let n = 0;
    const snap = [];
    for (let c = 0; c < a.owner.length; c++) if (a.owner[c]) {
      n++;
      snap.push([c, a.owner[c]]);
      const w = page.walls.get(c);
      if (!w || w.o !== a.owner[c]) wallDiff++;
    }
    snapBytes += Buffer.byteLength(JSON.stringify(snap));
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
  // ---- and what that minute cost the phone it was played on ----
  // The broadcast goes out ten times a second to every rider, so it is the only thing in this game that
  // can quietly become expensive to PLAY rather than to run. It stays cheap because walls travel as a
  // delta - the cells laid on this tick - and the page expires the old ones itself off wallTicks. That
  // is an easy thing to lose: sending this.walls each tick is the obvious simplification, every test
  // above would stay green, it looks identical on screen, and the bill lands on the player's data plan
  // where nobody developing on wifi would ever see it. Measured here rather than asserted: the same
  // seeded ten minutes carrying the standing walls each tick instead of the delta, which is what the
  // snap figure is, and the gap between the two numbers is the whole point of the guard.
  const per = bytes / bcasts, snapPer = (bytes + snapBytes) / bcasts;
  assert(per < 450, 'a tick costs the rider under 450 bytes (' + per.toFixed(0) + ' B, ' +
    (bytes / 1024 / 10).toFixed(0) + ' KB a minute of a busy arena)');
  assert(snapPer > 450, 'and carrying every standing wall each tick instead would blow that (' +
    snapPer.toFixed(0) + ' B a tick, ' + ((bytes + snapBytes) / 1024 / 1024 / 10 * 60).toFixed(0) +
    ' MB an hour against ' + (bytes / 1024 / 1024 / 10 * 60).toFixed(0) + ')');
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
  // Rows here carry no id on purpose: these are the three-field rows a page served from cache meets in
  // the minute after a deploy, so this block drives the name fallback. The id path the live referee
  // actually sends is driven on real broadcast output in the block directly below.
  const isYou = cond
    ? new Function('n', 'bot', 'id', 'me', 'names', 'return !!(' + cond + ')')
    : () => false;
  // the player is bike 7 riding as FLUX; bot 3 had the name first and keeps it
  const names = new Map([[7, {n: 'FLUX', bot: false}], [3, {n: 'FLUX', bot: true}]]);
  const top = [['FLUX', 44, 1], ['FLUX', 31, 0], ['VOLT', 12, 1]];
  const you = top.filter(([n, sc, bot]) => isYou(n, !!bot, undefined, 7, names));
  is(you.length, 1, 'exactly one row is highlighted when a bot shares the rider name');
  is(you.length === 1 && you[0][2], 0, 'and it is the rider, not the bot that was named first');
  is(top.filter(([n, sc, bot]) => isYou(n, !!bot, undefined, 7, new Map([[7, {n: 'VOLT', bot: false}]]))).length, 0,
    'and a rider whose name no live bike shares is not highlighted on a bot row');
}
// Two STRANGERS who both typed LOK is the case the bot dedupe cannot reach: the arena does not make a
// typed name unique, and by name the page found BOTH of them and lit both rows as 'you' - with whichever
// LOK was doing better sitting on top of your own score. Measured on the real referee 2026-10-18: the
// second LOK was shown two rows as his, reading 5 and 2, while his own run was worth 2. The row carries
// the bike id now, so the page matches on the one thing that is actually unique.
{
  const a = arena();
  const first = rider(a, 'LOK', 2, 2, 'D').b;          // one person
  for (let i = 0; i < 30; i++) a.step();                // give him a head start, so the scores differ
  const second = rider(a, 'LOK', 20, 2, 'D').b;        // a different person, same typed name
  rider(a, 'ZARA', 36, 2, 'D');
  for (let i = 0; i < 20; i++) a.step();
  assert(first.alive && second.alive && first.id !== second.id, 'two different riders are both in the arena as LOK');
  const top = a.feed.filter(m => m.top).pop().top;
  is(top.filter(([n]) => n === 'LOK').length, 2, 'the rider list carries both of them under the same name');
  is(top[0].length, 4, 'and every row now carries the bike id as its fourth field');
  assert(top.some(r => r[3] === second.id), "including the second LOK's own id");

  // the page's real condition, lifted out of index.html rather than restated
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pb = page.indexOf('function paintBoard');
  const mark = page.indexOf("? ' you' : ''", pb);
  const open = page.lastIndexOf('+ (', mark);
  const cond = page.slice(open + 3, mark).trim();
  const isYou = new Function('n', 'bot', 'id', 'me', 'names',
    'return !!(' + cond + ')');
  const names = new Map([...a.bikes.values()].map(b => [b.id, {n: b.name, bot: b.bot}]));
  const yours = top.filter(([n, , bot, id]) => isYou(n, !!bot, id, second.id, names));
  is(yours.length, 1, 'exactly one row is highlighted as the second LOK\'s own');
  assert(yours.length === 1 && yours[0][3] === second.id, 'and it is his bike, not the other LOK who is doing better');
  // the fix is the id: prove the old name-only rule really does fail this, so this check cannot pass by luck
  const byName = top.filter(([n, , bot]) => !bot && names.get(second.id) && n === names.get(second.id).n);
  is(byName.length, 2, 'matching by name alone would have highlighted both, which is the fault being fixed');
  // a cached page that meets a row with no id must still find itself, rather than nothing being highlighted
  is(top.filter(([n, , bot]) => isYou(n, !!bot, undefined, second.id, names)).length, 2,
    'a row with no id falls back to the name, so a mid-deploy page highlights too much rather than nothing');
}
// While you are on a bike the referee sends a tick every 100ms (see the broadcast at the end of step).
// So silence is a fault, and both faults that produce it leave the socket looking open from the page's
// side - a phone that loses signal sends no close, and a referee that stops ticking still answers /count
// and /top with a 200. The page's watch on that is the only thing between either fault and a rider
// staring at a frozen board, so it is run here verbatim rather than restated, body and all.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = page.indexOf('setInterval(() => {', page.indexOf('function hangUp'));
  const body = open > 0 ? page.slice(page.indexOf('{', open + 17) + 1, page.indexOf('}, 1000);', open)) : '';
  assert(body.includes('riding') && body.includes('tickAt') && body.includes('showResult'),
    'the page watches for an arena that has gone quiet under you');
  // `with` so the real body's own assignment to `riding` lands somewhere this test can read it back
  const run = body ? new Function('ctx', 'with (ctx) {' + body + '}') : () => {};
  const drive = (riding, quietMs) => {
    const ctx = {riding, tickAt: 0, dropped: false, shown: null,
      performance: {now: () => quietMs},
      hangUp() { ctx.dropped = true; },
      showResult(s, reason) { ctx.shown = reason; }};
    run(ctx);
    return ctx;
  };
  is(drive(true, 100).shown, null, 'a tick that landed 100ms ago is an arena running normally');
  is(drive(true, 4900).shown, null, 'and 4.9s of quiet is still given the benefit of the doubt');
  const out = drive(true, 5100);
  is(out.shown, 'lost', 'an arena quiet for over 5s under a rider is reported as a lost connection');
  is(out.dropped, true, 'and the socket is let go rather than left holding the arena open');
  is(out.riding, false, 'and the rider is off the bike, so it is reported once and not every second');
  is(drive(false, 600000).shown, null, 'a menu left open all day is never told it was disconnected');
}
// The menu's attract loop is the first thing every visitor sees, and it exists for one reason: with no
// socket open the floor used to be empty, which read as a dead game. So "the riders keep riding" is the
// whole requirement, and nothing had ever checked it. It cannot be checked live - the loop only runs
// where there is no socket and no server - so it is lifted out of index.html and driven here, verbatim,
// the same way the quiet-arena watch above is. Seeded, because an assertion about a random walk that
// flakes once a week is worse than no assertion.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = page.indexOf('const DEMO = [');
  const end = page.indexOf('\nlet last', open);
  // the headings the loop steers by are declared at the top of the page, not next to it
  const dirs = (page.match(/const DIRN = \[[^;]+;/) || [''])[0];
  const src = open > 0 && end > open && dirs ? dirs + page.slice(open, end) : '';
  assert(src.includes('function demoStep') && src.includes('bikes.set') && src.includes('DIRN'),
    'the menu has an attract loop that rides without a server');
  // mulberry32, so the same arena plays out every run. A plain LCG was tried first and multiplies
  // past 2^53 in a double, which degenerates and invented a 5s dead menu that the real loop never has.
  const seeded = seed => { let s = seed >>> 0; const M = Object.create(Math);   // Object.create keeps the rest of Math
    M.random = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; return M; };
  const ride = (seed, ticks) => {
    const ctx = {W: 40, H: 60, WALL_TICKS: 80, tick: 0, tickAt: 0,
      walls: new Map(), bikes: new Map(), Math: seeded(seed),
      performance: {now: () => ctx.tick * 100},
      derez: () => {}, colOf: () => '#fff'};   // particles and colour: nothing to measure
    const step = new Function('ctx', 'with (ctx) {' + src + '\nreturn demoStep; }')(ctx);
    let empty = 0, worstGap = 0, gap = 0, mostWalls = 0, aliveSum = 0;
    for (let i = 0; i < ticks; i++) {
      step();
      aliveSum += ctx.bikes.size;
      mostWalls = Math.max(mostWalls, ctx.walls.size);
      if (ctx.bikes.size) gap = 0; else { empty++; worstGap = Math.max(worstGap, ++gap); }
    }
    return {empty, worstGap, mostWalls, mean: aliveSum / ticks};
  };
  // 6000 ticks is ten simulated minutes - longer than anyone reads a menu for
  for (const seed of [1, 7]) {
    const r = src ? ride(seed, 6000) : {empty: 6000, worstGap: 6000, mostWalls: 0, mean: 0};
    assert(r.mean > 3, 'the menu keeps riders on the floor over ten minutes, seed ' + seed +
      ' (' + r.mean.toFixed(2) + ' of 4)');
    assert(r.empty < 300, 'and the floor is almost never empty (' + (100 * r.empty / 6000).toFixed(2) + '% of ticks)');
    // the one that matters: a long dead stretch is the "reads as dead" fault coming back
    assert(r.worstGap <= 30, 'and never sits empty for 3s at a stretch (worst ' + (r.worstGap / 10).toFixed(1) + 's)');
    // four riders laying at most one cell a tick, fading after WALL_TICKS, can never hold more than 320
    assert(r.mostWalls > 0 && r.mostWalls <= 320,
      'and the menu walls fade instead of filling the floor (peak ' + r.mostWalls + ' of 320)');
  }
}
// ---- the score a rider is shown while riding is the score the board keeps ----
// Score is computed in THREE places and nothing has ever checked they agree: the live rider list in
// the broadcast, the death event the result screen reads, and the row the referee writes to the board.
// All three say floor(seconds alive) + 10 per knockout today. If one ever drifts the game goes quietly
// wrong in the one place every player looks - you ride a run shown as 34, the result screen says 34
// and the board remembers 33 - and no existing check would catch it, because each half is perfectly
// self-consistent on its own. This is the same two-halves-disagree class as the dimmed BLADE button.
{
  const a = arena({board: true});
  const {b} = rider(a, 'TALLY', 20, 5, 'D');   // down the long axis: 54 cells of room, no blade, no walls
  b.kos = 2;   // so the knockout half of the sum is pinned too, not just the seconds half
  // ride to a tick the rider list is actually sent on (every 10th) and far enough in that floor() moved
  while (a.tick % 10 !== 0 || a.tick - b.start < 30) a.step();
  const elapsed = a.tick - b.start, want = Math.floor(elapsed / 10) + 10 * b.kos;
  const row = a.feed.filter(m => m.top).pop().top.find(([n]) => n === 'TALLY');
  is(row && row[1], want, 'the live rider list scores a run the way the referee does');
  // the referee's own kill, at a known elapsed count rather than waiting on a lucky crash
  a.kill(b, 0, 'edge');
  a.step();   // out.e rides out on the next broadcast
  const ev = events(a).find(e => e[0] === b.id);
  is(ev && ev[3], want, 'and the result screen is told that same score');
  const kept = a.runs[a.runs.length - 1];
  is(kept && kept[2], want, 'and that is the score the board keeps');
  is(kept && kept[1], 'TALLY', 'under the name the rider actually used');
}
// ---- a browser that refuses to make an AudioContext must not cost a player a crash report ----
// Every other browser API the page touches is guarded - localStorage, setPointerCapture, every fetch -
// and this one was not. unlockAudio is bound to pointerdown AND keydown, so an embedded browser that
// throws on construction threw on every input for the whole visit, because actx stayed null and the
// next one tried again. The missing sound is the cheap half: the page's own window error handler turns
// a throw into one of the THREE crash notes a player ever gets to file, spending it on absent sound the
// game plays perfectly well without. resume() is a promise and rejects on its own, which the
// unhandledrejection handler would have reported the same way. Lifted out of the page rather than
// restated, and driven three ways, so these fail if either guard is taken back out.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const decl = (page.match(/let actx = null,[^\n]*\n/) || [''])[0];
  const open = page.indexOf('function unlockAudio() {');
  const end = page.indexOf('\n}', open);
  const src = decl && open > 0 && end > open ? decl + page.slice(open, end + 2) : '';
  assert(src.includes('noAudio') && src.includes('new A()'), 'unlockAudio is lifted out of the page');
  let unhandled = 0;
  process.on('unhandledRejection', () => unhandled++);
  const drive = mode => {
    let built = 0, resumed = 0, escaped = null;
    function Ctx() {
      built++;
      if (mode === 'throw') throw new Error('audio is not allowed here');
      this.state = 'suspended';   // never becomes 'running', so resume() is attempted on every call
      this.resume = () => { resumed++; return mode === 'reject' ? Promise.reject(new Error('no')) : Promise.resolve(); };
    }
    const unlock = new Function('ctx', 'with (ctx) {' + src + '\nreturn unlockAudio; }')({window: {AudioContext: Ctx}});
    for (let i = 0; i < 5; i++) { try { unlock(); } catch (e) { escaped = e; } }
    return {built, resumed, escaped};
  };
  const no = drive('throw');
  is(no.escaped, null, 'a browser that throws on AudioContext never throws out of an input handler');
  is(no.built, 1, 'and it is asked once rather than on every tap for the rest of the visit');
  const ok = drive('ok');
  is(ok.built, 1, 'a browser that allows audio still gets exactly one context');
  is(ok.resumed, 5, 'and a context left suspended is still resumed on every input');
  drive('reject');
  await new Promise(r => setTimeout(r, 20));   // a rejection is only unhandled once the microtasks drain
  is(unhandled, 0, 'and a resume() that rejects is swallowed rather than reported as a crash');
}
// ---- a crash report that could not be sent must not cost the player the slot it was sent in ----
// The page gives a player THREE crash notes a visit, and it used to spend one on every attempt rather
// than on every delivery. So a server that was unreachable for a few seconds, or the arena's own /say
// guard - 30 notes a minute shared by everyone, which a launch day with twelve riders reaches easily -
// ate the first three errors and then went quiet for the rest of the visit, having filed nothing. That
// is the failure the whole report path exists to prevent, and it failed silently, which is the one
// thing the Snaked lesson beside it says is a blocker. Lifted out of the page rather than restated,
// and driven with a server that refuses, one that accepts, and one that comes back, so these fail if
// either half of the fix - giving the slot back, or the ceiling that stops it storming - is taken out.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const decl = (page.match(/let reports = 0,[^\n]*\n/) || [''])[0];
  const open = page.indexOf('function report(what) {');
  const end = page.indexOf('\n}', open);
  const src = decl && open > 0 && end > open ? decl + page.slice(open, end + 2) : '';
  assert(src.includes('tries') && src.includes("say('err'"), 'report is lifted out of the page');
  const drive = () => {
    let sent = 0, mode = 'fail';
    const say = () => { sent++; return mode === 'fail' ? Promise.reject(new Error('503')) : Promise.resolve(); };
    const report = new Function('ctx', 'with (ctx) {' + src + '\nreturn report; }')({say});
    return {report, sent: () => sent, up: () => { mode = 'ok'; }};
  };
  // a server that is down for the whole visit: the three slots are never spent, and the retries stop
  const down = drive();
  for (let i = 0; i < 40; i++) { down.report('boom @ x:' + i); await Promise.resolve(); }
  is(down.sent(), 9, 'a server that refuses every note is tried nine times and then left alone');
  // the note that mattered arrives the moment the server comes back, instead of being refused for good
  const back = drive();
  back.report('the one that matters');
  await Promise.resolve();
  is(back.sent(), 1, 'the first error is sent once while the server is down');
  back.report('the one that matters');
  await Promise.resolve();
  is(back.sent(), 2, 'and a note that failed to send is tried again when the same fault fires');
  back.up();
  back.report('the one that matters');
  await Promise.resolve();
  is(back.sent(), 3, 'and it goes through once the server is back');
  back.report('the one that matters');
  await Promise.resolve();
  is(back.sent(), 3, 'after which it is remembered and never sent twice');
  // a healthy server still only hears three, so one broken frame cannot flood the player inbox
  const up = drive();
  up.up();
  for (let i = 0; i < 20; i++) { up.report('broken frame @ y:' + i); await Promise.resolve(); }
  is(up.sent(), 3, 'a player still only ever files three notes a visit');
}
// ---- the numbers in the public post must be the numbers the referee actually plays by ----
// press/launch-copy.md and press/itch-description.txt are not notes to ourselves: they are the words
// that go on itch and into a Reddit post, read by people who have not played yet, and they state the
// balance of this game as fact - three seconds of blade, six to recharge, walls for eight, six bikes,
// ten a knockout. Every one of those is a constant at the top of the referee, so one tuning edit turns
// the announcement into a lie that nothing on either side would notice: the game would play correctly
// and the post would describe a game that no longer exists. That is the same fault already found four
// times in the launch kit this month - a press shot one day older than a camera change, og.png and all
// five icons still drawing the bike from before the redesign, a demo clip sold with a cyan rider that
// was never in it - and every one of them was found by somebody looking, never by a check. The numbers
// are the half that can be pinned, so they are pinned here. Proved to DISCRIMINATE rather than merely
// agree with today's copy: each of the five constants was bent by one, and each time both files were
// caught. Prose is matched with whitespace flattened, because 'three seconds\nof blade' is the same
// claim as 'three seconds of blade' and a line re-wrap must never read as the copy having gone stale.
{
  const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
  const num = k => Number((src.match(new RegExp(k + ' = ([0-9]+)')) || [])[1]);
  const secs = k => num(k) * num('TICK_MS') / 1000;
  // the per-second half of the score is the coefficient on Math.floor(secs), and the copy calls it one
  // point a second. If that expression ever stops being a bare floor plus a flat rate, the sentence
  // needs rewriting by hand - so the match not holding IS the finding, not a broken test
  const ko = src.match(/score = Math[.]floor[(]secs[)] [+] ([0-9]+) [*] b[.]kos/);
  assert(ko, 'the score rule is still one point a second alive plus a flat rate per knockout');
  const WORD = {1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
    7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve'};
  const flat = f => readFileSync(new URL('../press/' + f, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const copy = {'launch-copy.md': flat('launch-copy.md'), 'itch-description.txt': flat('itch-description.txt'),
    // README.md states the same balance in digits rather than words, and it is the first thing anyone
    // reading the repo is told. It also carries the one number neither press file mentions - the 1s the
    // charge waits at zero after running dry - so without this it was the only public statement of that
    // rule with nothing holding it to the referee.
    'README.md': readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')};
  const blade = secs('BLADE_TICKS'), recharge = secs('RECHARGE_TICKS'), wall = secs('WALL_TICKS');
  const target = num('TARGET'), perKo = ko ? Number(ko[1]) : 0, dry = secs('EMPTY_GAP');
  const claims = [
    ['the blade lasts ' + blade + 's', 'launch-copy.md', 'about $ seconds of blade', blade],
    ['the blade lasts ' + blade + 's', 'itch-description.txt', 'about $ seconds of blade', blade],
    ['recharging takes ' + recharge + 's', 'launch-copy.md', '$ seconds to recharge', recharge],
    ['recharging takes ' + recharge + 's', 'itch-description.txt', '$ seconds to get it back', recharge],
    ['a wall stands for ' + wall + 's', 'launch-copy.md', 'fade after $ seconds', wall],
    ['a wall stands for ' + wall + 's', 'itch-description.txt', 'fade after $ seconds', wall],
    ['bots top the arena up to ' + target + ' bikes', 'launch-copy.md', 'arena at $ bikes', target],
    ['bots top the arena up to ' + target + ' bikes', 'itch-description.txt', 'arena at $ bikes', target],
    ['a knockout is worth ' + perKo, 'launch-copy.md', '$ a knockout', perKo],
    ['a knockout is worth ' + perKo, 'itch-description.txt', '$ a knockout', perKo],
    ['the blade lasts ' + blade + 's', 'README.md', 'about $s of wall', blade, 1],
    ['recharging takes ' + recharge + 's', 'README.md', '$s to recharge', recharge, 1],
    ['the charge waits ' + dry + 's at zero', 'README.md', 'a $s wait if you run it dry', dry, 1],
    ['a wall stands for ' + wall + 's', 'README.md', 'fade after $s', wall, 1],
    ['bots top the arena up to ' + target + ' bikes', 'README.md', 'up to $ bikes', target, 1],
  ];
  for (const [rule, file, phrase, value, digits] of claims) {
    const want = phrase.replace('$', digits ? value : WORD[value] || '(' + value + ' - no word for it)');
    assert(new RegExp(want, 'i').test(copy[file]), file + ' says ' + rule + ' ("' + want + '")');
  }
}
// ---- a tick the page could not apply must not pass for an arena that is running ----
// The quiet-arena watch above is the only thing between a frozen board and a rider staring at it, and
// everything it knows comes from tickAt. So what sets tickAt is what the watch is actually measuring,
// and setting it on the FIRST line of the tick branch made it "a tick message arrived" rather than "a
// tick was applied". Those two come apart in precisely the case the watch exists for. A throw anywhere
// in applying a tick escapes onMsg; the socket is untouched and delivers the next tick 100ms later,
// which throws in the same place, for ever. The board stops moving, the watch is refreshed ten times a
// second by the very handler that is failing, and it never fires - so the rider gets no score, no
// result screen and no way back to the menu but a reload, which is the exact outcome the watch was
// written to prevent. The page's error handler files one crash report and dedupes the rest, so it is
// quiet after the first. Driven here verbatim out of index.html, the same way the watch itself is: a
// clean tick must set the clock and a failed one must leave it alone. The second half of that goes RED
// on its own if the assignment is ever moved back up to the top of the branch.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = page.indexOf('function onMsg(m) {');
  const end = page.indexOf('// Each step starts from where the bike is drawn', open);
  const src = open > 0 && end > open ? page.slice(open, end) : '';
  assert(src.includes("m.t === 'k'") && src.includes('tickAt'),
    'the page applies the arena tick in onMsg, against the clock the quiet-arena watch reads');
  // everything the tick branch touches, stubbed; the other branches are never entered, so the page's
  // own W, H, riding and the rest are not needed here
  const build = () => {
    const ctx = {
      tick: 0, tickAt: 111, pend: [], pendAt: 0, me: 9, WALL_TICKS: 80, reached: false,
      bikes: new Map(), walls: new Map(), names: new Map(),
      performance: {now: () => 999},
      drawT: () => 0, setBike: () => {}, paintBoard: () => {}, paint: () => {},
      $: () => ({textContent: '', classList: {toggle() {}}}),
      onOut() { ctx.reached = true; throw new Error('a throw while applying the tick'); },
    };
    ctx.apply = src ? new Function('ctx', 'with (ctx) {' + src + '\nreturn onMsg; }')(ctx) : () => {};
    return ctx;
  };
  const good = build();
  good.apply({t: 'k', k: 4, b: []});
  is(good.tick, 4, 'a tick the page applied cleanly moves the page onto that tick');
  is(good.tickAt, 999, 'and sets the clock the quiet-arena watch reads');
  const bust = build();
  let threw = false;
  try { bust.apply({t: 'k', k: 5, b: [], e: [[1, 0, 'edge', 3, 30, 0]]}); } catch (e) { threw = true; }
  is(threw, true, 'a fault while applying a tick still escapes the handler, as it always did');
  is(bust.reached, true, 'and the fault really was reached, rather than the message being skipped');
  is(bust.tickAt, 111,
    'but it leaves the clock untouched, so ticks the page cannot apply read as the dropped connection they amount to');
}
// ---- the sizes the page and the manifest DECLARE for the shipped images must be the real ones ----
// og.png and the four icons were every one regenerated today, by scripts written today, out of the
// page's own cycle() - which put right a card and five icons that had been drawing the bike from
// before the redesign for three and a half weeks. What nothing checks is the half that is WRITTEN
// DOWN rather than drawn: index.html tells every link preview the card is 1200x630, and manifest.json
// tells a launcher each icon is whatever its sizes field says. Those are claims about a file, exactly
// like the balance numbers pinned above, and they go stale the same silent way - a canvas size changed
// in press/make-og.py or press/make-icons.py leaves the declaration lying, both files still look
// perfectly good on their own, and the game plays correctly throughout. The cost lands where it can
// least be taken back: a scraper that trusts the meta tags crops or letterboxes the one image of this
// game that travels on its own, into a Reddit post and a chat preview, in front of people who have not
// clicked anything yet; a launcher handed a wrong size picks the wrong icon or refuses it. Read out of
// the PNG header, so it is the FILE that answers here and never the script that wrote it.
{
  const png = f => {
    const b = readFileSync(new URL('../' + f, import.meta.url));
    return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20);
  };
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const meta = p => (page.match(new RegExp('og:image:' + p + '" content="([0-9]+)')) || [])[1];
  is(png('og.png'), meta('width') + 'x' + meta('height'),
    'og.png is really the size index.html tells every link preview it is');
  const icons = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).icons;
  is(icons.length, 4, 'the manifest still ships four icons');
  // four DISTINCT ones: a size check alone passes a manifest that lists one icon twice, and writing one
  // scale over another is a fault this project has actually had - make-icons.py gave both maskable
  // scales the same probe filename on 17 Oct and produced two pixel-identical files
  is(new Set(icons.map(i => i.src)).size, 4, 'and four different files, not one of them listed twice');
  for (const {src, sizes} of icons) is(png(src), sizes, src + ' is really the size manifest.json says it is');
}
// ---- a wall that still kills must still be visible ----
// The referee and the page keep two halves of one fact: the referee decides how long a barricade kills
// for, the page decides how long it is drawn for, and nothing had ever checked that the second covers
// the first. It did not. The fade ran linearly to NOTHING over the last 2s, so measured against the
// real referee the last three lethal ticks of every wall drew at 12%, 12% and 0% of full brightness -
// a 6% stroke on a #0d1420 floor, then literally nothing, while killing anyone who touched them. A bike
// moves a cell a tick, so a rider could cross three cells of a wall that was not on his screen and die
// on what looked like bare floor. Silent in the way that counts: the arena plays perfectly, the referee
// is right, and the only thing wrong is what the player can see. The lethal window here is MEASURED off
// the referee rather than read off WALL_TICKS, so a change to how walls expire has to keep the drawing
// honest too. Proved to discriminate: the same sweep run against the old no-floor expression must find
// a lethal tick drawn at zero.
{
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const fadeExpr = page.match(/const age = tick - w\.born \+ t, a = [^\n]+;/);
  const stepExpr = page.match(/const step = Math\.round\(a \* ([0-9]+)\)/);
  assert(!!fadeExpr, 'the page fades a barricade on that cell\'s own age');
  assert(!!stepExpr, 'and rounds the fade into steps, so the glow is a few strokes and not one per cell');
  const steps = stepExpr ? +stepExpr[1] : 8;
  const alpha = expr => {
    const f = new Function('tick', 'w', 't', 'WALL_TICKS', expr + ' return a;');
    return (age, wallTicks) => Math.round(Math.max(0, f(age, {born: 0}, 0, wallTicks)) * steps) / steps;
  };
  const now = fadeExpr ? alpha(fadeExpr[0]) : () => 0;
  const was = alpha('const age = tick - w.born + t, a = age > WALL_TICKS - 20 ? Math.max(0, (WALL_TICKS - age) / 20) : 1;');

  // one cell, laid by a rider who then rides a lap so it is never its own wall that ends the run - a
  // barricade vanishes with its owner, so a rider who died early would cut the window short and the
  // whole sweep would pass on a wall that never got old
  const a = arena();
  const {b, say} = rider(a, 'LOK', 2, 2, 'R');
  say({t: 'blade', on: true});
  const cell = b.y * 40 + b.x;
  a.step();
  say({t: 'blade', on: false});
  const born = a.born[cell], lethal = [];
  for (let i = 0; i < 100; i++) {
    if (b.dir === 'R' && b.x >= 37) say({t: 'turn', d: 'D'});
    else if (b.dir === 'D' && b.y >= 57) say({t: 'turn', d: 'L'});
    else if (b.dir === 'L' && b.x <= 4) say({t: 'turn', d: 'U'});
    a.step();
    if (a.owner[cell]) lethal.push(a.tick - born);
  }
  assert(b.alive, 'the rider lasts long enough for its one barricade to expire under it');
  const wallTicks = lethal.length ? lethal[lethal.length - 1] + 1 : 0;
  is(lethal[0], 1, 'the barricade kills from the tick after it is laid');
  is(wallTicks, 80, 'and the referee lets go of it at 80 ticks of age');
  const dimmest = Math.min(...lethal.map(age => now(age, wallTicks)));
  is(lethal.filter(age => now(age, wallTicks) <= 0).length, 0,
    'not one tick of a wall that still kills is drawn at nothing');
  assert(dimmest >= 0.25, 'and the dimmest a lethal wall ever gets is ' + Math.round(dimmest * 100)
    + '% of full, not a shade of the floor');
  // the floor only stays honest because the page throws the cell away on the same tick the referee
  // does - otherwise it would hold a dim ribbon on screen over floor that is safe to ride
  const prune = page.match(/if \(w\.born \+ WALL_TICKS <= tick\) walls\.delete\(c\);/g) || [];
  is(prune.length, 2, 'the page drops a barricade on the same tick the referee does, in both its loops');
  // and the check earns its keep: the fade it replaced has to be caught by this same sweep
  assert(lethal.some(age => was(age, wallTicks) <= 0),
    'the fade this replaced drew a still-lethal wall at zero, and this sweep catches it');
  assert(lethal.filter(age => was(age, wallTicks) < 0.25).length >= 3,
    'along with the ticks either side of it that were only a shade brighter than the floor');
}


// ---- the standings on a rider's first frame are this arena's, not the last run's ----
// The corner panel is the one thing on screen that names the other riders, and the broadcast only
// carries it on every tenth tick - so a rider who joins on any other tick had it un-hidden still
// holding the rows of their PREVIOUS run, for up to 900ms measured here. That is not merely stale:
// showResult hangs up, a solo rider's socket is then the last one, and the arena's stop() calls
// reset(), which puts nextId back to 1 - so a dead row from the old arena can carry the new rider's
// own id and light up in cyan as him, wearing a finished rider's score. Exactly the bug fixed on
// 18 Oct (both LOKs highlighted by name), coming back through a door the id fix does not cover.
// Fixed by sending the standings with the 'you' message, which the arena already sends to that one
// socket, and painting them before the panel is shown.
{
  const a = arena();
  rider(a, 'AAA', 10, 10, 'R');
  rider(a, 'BBB', 30, 40, 'L');
  for (let i = 0; i < 25; i++) a.step();
  assert(a.nextId > 1, 'ids climb while an arena is up');
  a.stop();
  is(a.nextId, 1, 'and go back to 1 when the last socket goes, so a dead row can carry a live id');

  const c = arena();
  rider(c, 'AAA', 10, 10, 'R');
  rider(c, 'BBB', 30, 40, 'L');
  while (c.tick % 10 !== 1) c.step();          // join on a tick the broadcast does NOT carry standings on
  const got = [];
  const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
  c.socks.add(s);
  c.onMsg(s, JSON.stringify({t: 'join', name: 'NEW'}));
  for (let i = 0; i < 200 && s.waiting !== undefined; i++) c.trySpawn(s);
  const you = got.find(m => m.t === 'you');
  assert(you, 'a rider joining mid-second is told where they were dropped');
  assert(you && you.top, 'and the standings come with it, rather than waiting for the next broadcast');
  const alive = new Set([...c.bikes.keys()]);
  assert(you && you.top.every(([, , , id]) => alive.has(id)),
    'every row names a bike riding in this arena right now');
  assert(you && you.top.some(([, , , id]) => id === you.id), 'the new rider is on it, so the panel can mark him');
  // and the window the fix closes is real: count the ticks the broadcast would have left it unpainted
  let wait = 0;
  for (;;) { got.length = 0; c.step(); wait++; if (got.some(m => m.top) || wait > 20) break; }
  assert(wait >= 5, 'the broadcast alone would have left the panel unpainted for ' + wait * 100 + 'ms');

  // the PAGE's half, driven out of index.html: the panel must be painted before it is un-hidden
  const pg = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = pg.indexOf('function onMsg(m) {');
  const end = pg.indexOf('// Each step starts from where the bike is drawn', open);
  const src = open > 0 && end > open ? pg.slice(open, end) : '';
  assert(src.includes("m.t === 'you'"), 'the page takes its seat in onMsg');
  const run = msg => {
    const log = [];
    const ctx = {
      W: 40, H: 60, me: 0, tick: 7, myStart: 0, pend: [], myKos: 0, bladeOn: false, riding: false,
      WALL_TICKS: 80, TICK_MS: 100, isTouch: false, walls: new Map(), bikes: new Map(), names: new Map(),
      performance: {now: () => 1}, setBike: () => {}, paint: () => {}, hangUp: () => {},
      paintBoard: top => log.push(['paint', top]),
      $: id => ({set hidden(v) { if (id === 'board' && v === false) log.push(['show']); },
                 textContent: '', classList: {toggle() {}}}),
    };
    ctx.apply = src ? new Function('ctx', 'with (ctx) {' + src + ';return onMsg; }')(ctx) : () => {};
    ctx.apply(msg);
    return log;
  };
  const log = run({t: 'you', id: you.id, b: [you.id, 10, 10, 0, 0, 100], top: you.top});
  const painted = log.findIndex(e => e[0] === 'paint'), shown = log.findIndex(e => e[0] === 'show');
  assert(painted >= 0, 'the page paints the standings it was handed');
  assert(painted >= 0 && shown > painted, 'and does it before the panel is shown, so no stale frame reaches the screen');
  assert(painted >= 0 && log[painted][1] === you.top, 'with the rows the arena sent, not a guess');
  // red against the old rule: with no standings on the message the panel went up unpainted, which is
  // what left the last run's rows - and a reused id highlighted as you - on screen for up to 900ms
  const bare = run({t: 'you', id: you.id, b: [you.id, 10, 10, 0, 0, 100]});
  assert(!bare.some(e => e[0] === 'paint') && bare.some(e => e[0] === 'show'),
    'and a "you" with no standings on it - the message this replaced - really did show the panel unpainted');
}

// ---- the clock in front of the rider is the referee's clock ----
// The HUD's "alive" tile is the fourth copy of the score, and the only one the rider watches count up.
// It is drawn from myStart, which the page set to the last tick it had APPLIED - and a join is handled
// the moment it arrives rather than on a tick boundary, so any tick still in flight is one the page has
// not applied yet. Measured on this referee: a seat cut on tick 21 against a page holding 20 had the HUD
// reading 0.1s while the referee said 0.0, and it stayed a tick ahead for the whole run. The rider rode
// a run shown as 15.3 and was handed 15.1 by the result screen, which takes the referee's own number -
// the same two-halves-of-one-fact shape as the walls drawn at nothing and the standings from the last
// run. The remaining time in the current tick is what a join has to beat and it is anywhere in 0-100ms,
// so a phone with 60ms of round trip loses that race on most joins and a slow one loses it by two ticks.
// Fixed by sending the tick with the seat, on the same bespoke message that already carries the
// position and the standings.
{
  const a = arena();
  rider(a, 'AAA', 10, 10, 'R');
  for (let i = 0; i < 20; i++) a.step();
  const got = [];
  const s = {ws: {send: t => got.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now(), idle: 0};
  a.socks.add(s);
  a.onMsg(s, JSON.stringify({t: 'join', name: 'LOK'}));       // arrives between ticks, like every real join
  for (let i = 0; i < 200 && s.waiting !== undefined; i++) a.trySpawn(s);
  const you = got.find(m => m.t === 'you');
  assert(you && you.k !== undefined, 'the seat says which tick it was cut on');
  is(you && you.k, s.bike.start, 'and it is the tick the referee started the run on');
  assert(!got.some(m => m.t === 'k' && m.k === you.k),
    'which the page could not have known: no broadcast for that tick has been sent to it yet');
  // and the gap really does ride out the run rather than closing itself
  const behind = you.k - 1;                                    // what the page would have had
  for (let i = 0; i < 30; i++) a.step();
  is((a.tick - behind) - (a.tick - s.bike.start), 1,
    'three seconds later the old clock is still exactly one tick ahead of the referee');

  // the PAGE's half, driven out of index.html
  const pg = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = pg.indexOf('function onMsg(m) {');
  const end = pg.indexOf('// Each step starts from where the bike is drawn', open);
  const src = open > 0 && end > open ? pg.slice(open, end) : '';
  assert(src.includes("m.t === 'you'"), 'the page takes its seat in onMsg');
  const seat = msg => {
    const ctx = {
      W: 40, H: 60, me: 0, tick: behind, myStart: 0, pend: [], myKos: 0, bladeOn: false, riding: false,
      WALL_TICKS: 80, TICK_MS: 100, isTouch: false, walls: new Map(), bikes: new Map(), names: new Map(),
      performance: {now: () => 1}, setBike: () => {}, paint: () => {}, hangUp: () => {}, paintBoard: () => {},
      $: () => ({set hidden(v) {}, textContent: '', classList: {toggle() {}}}),
    };
    new Function('ctx', 'with (ctx) {' + src + ';return onMsg; }')(ctx)(msg);
    return ctx;
  };
  const ctx = seat({t: 'you', id: you.id, k: you.k, b: [you.id, 10, 10, 0, 0, 100], top: you.top});
  is(ctx.myStart, s.bike.start, 'a page a tick behind starts its clock on the tick the referee gave it');
  is(((you.k - ctx.myStart) / 10).toFixed(1), '0.0', 'so the HUD reads 0.0 on the first frame of the run');
  // red against the old rule: the message without the tick on it is what the page used to get
  const was = seat({t: 'you', id: you.id, b: [you.id, 10, 10, 0, 0, 100], top: you.top});
  is(was.myStart, behind, 'and the message this replaced really did start it a tick early');
  is(((you.k - was.myStart) / 10).toFixed(1), '0.1', 'which is the 0.1s the HUD used to be ahead by');
}

// ---- a board the page knows is behind must be re-asked until it is current, and then go quiet ----
// The result screen tells a rider "That run still counted - look for your name on the board", and on the
// dropped-connection path the thing that has just failed is the network, so that screen's own re-ask is
// the one most likely to fail. What catches it afterwards is the menu's 20s beat, and that beat used to
// re-ask the board ONLY when there was none at all - so a player whose signal came back was shown the
// board from BEFORE their run for the rest of the visit, with the rider count beside it updating off the
// same beat and proving the page had its signal back. Fixed 19 Oct by marking the rows on screen as
// behind and letting the beat keep trying. Pinned here because it is one flag read in three places - set
// on the result screen, read by the beat, cleared by a landing board - and an edit to any one of them
// silently restores the old behaviour. BOTH halves are checked, because they fail in opposite
// directions: too few asks is the bug above, and never clearing the flag means an idle menu asks the
// arena twice a beat for ever, which is a bill on the one Cloudflare allowance that can actually run out.
{
  const pg = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // The WHOLE beat, not its first line. It grew a second arm on 19 Oct (the day-rollover check at the
  // foot of this block) and a one-line lift then handed this harness half a function - which does not
  // quietly test less, it throws, so the suite says so rather than going green over nothing.
  const bOpen = pg.indexOf('const menuPoll = ');
  const beat = pg.slice(bOpen, pg.indexOf('\n};', bOpen) + 3);
  const open = pg.indexOf('function loadTop() {');
  const end = pg.indexOf('// the same tap retries it', open);
  const src = open > 0 && end > open ? pg.slice(open, end) : '';
  assert(src.includes('lbStale = false'), 'a board that lands clears the mark saying the rows are behind');
  const res = pg.slice(pg.indexOf('function showResult('), pg.indexOf('function paintBoard('));
  assert(res.includes('lbStale = true'), 'and a finished run sets it, so the beat knows to try');

  const settle = () => new Promise(r => setTimeout(r, 0));
  // the menu's beat and its board loader, driven out of index.html with the fetch under this test's thumb
  const menu = (rows, gate) => {
    const ctx = {lbView: 'today', lbData: rows, lbStale: false, lbDay: '', asks: 0, answer: null,
      day: '2026-10-19', utcDay: () => ctx.day,   // the clock is the test's, so a turnover can be staged
      paintLb: () => {}, liveCount: () => {}, http: p => p, $: () => ({}),
      fetch: () => { ctx.asks++; return ctx.answer(); }};
    ctx.beat = new Function('ctx', 'with (ctx) {' + src + (gate || beat) + '; return menuPoll; }')(ctx);
    return ctx;
  };
  const lost = () => Promise.reject(new Error('no signal'));
  const lands = d => () => Promise.resolve({ok: true, json: () => Promise.resolve(d)});
  const was = [['SDF', 29, 19.6, 1]], now = [['LOK', 41, 31.2, 1], ['SDF', 29, 19.6, 1]];

  const m = menu(was);
  m.answer = lost;
  m.beat(); await settle();
  is(m.asks, 0, 'a menu whose board is current does not ask for it again');
  m.lbStale = true;                                   // a run has just ended under a failed re-ask
  m.beat(); await settle();
  is(m.asks, 1, 'once the rows are known to be behind the beat asks for them');
  is(m.lbData, was, 'a re-ask that fails keeps the board on screen rather than blanking it');
  assert(m.lbStale, 'and leaves it marked behind: it is still the board from before the run');
  m.beat(); await settle();
  is(m.asks, 2, 'so the next beat asks again - this is the ask the old gate never made');
  m.answer = lands({day: '2026-10-19', today: now, all: now});
  m.beat(); await settle();
  is(m.asks, 3, 'the beat that finally gets through');
  is(m.lbData.today, now, 'and the rider is shown the board with their own run on it');
  assert(!m.lbStale, 'the rows are current, so the mark comes off');
  m.beat(); m.beat(); await settle();
  is(m.asks, 3, 'and an idle menu goes back to costing nothing: two more beats, no further asks');

  // red against the old rule: the gate this replaced asked only when there was no board at all
  const old = menu(was, 'const menuPoll = () => { liveCount(); if (!lbData) loadTop(); };');
  old.answer = lands({today: now, all: now});
  old.lbStale = true;
  old.beat(); old.beat(); old.beat(); await settle();
  is(old.asks, 0, 'the gate this replaced really did leave the player on the board from before their run');
  is(old.lbData, was, 'and nothing ever replaced it for the rest of the visit');

  // ---- and the same beat has to notice the UTC day turning over under an open menu ----
  // The referee stamps every run with a UTC day, so that Today means the same day for everyone, and it
  // sends the day it used along with the board. The page threw that field away: the gate above re-asks
  // only for a board that is MISSING or marked behind, so the rows fetched on one UTC day stayed on
  // screen for the whole visit under a tab reading Today. Measured 19 Oct by driving this same beat an
  // hour past midnight - 180 beats, ZERO re-asks, the previous day's run still on the Today tab while
  // the arena's own Today had gone empty. Checked in BOTH directions for the same reason the gate above
  // is: too few asks is the bug itself, and one ask a beat for ever is a bill on the single Cloudflare
  // allowance that can actually run out.
  assert(pg.includes('const utcDay = () => new Date().toISOString().slice(0, 10)'),
    'the page works out the day the same way the referee does, to the letter');
  const beats = async (c, n) => { for (let i = 0; i < n; i++) { c.beat(); await settle(); } };
  const board = (day, rows) => ({day, today: rows, all: was});

  const r = menu(board('2026-10-19', was));
  r.answer = lands(board('2026-10-20', []));
  await beats(r, 1);
  is(r.asks, 0, 'a menu still on the day its board was fetched does not ask for it again');
  r.day = '2026-10-20';                       // midnight UTC passes with the menu sitting open
  await beats(r, 1);
  is(r.asks, 1, 'the turnover is noticed and the board is asked for');
  is(r.lbData.day, '2026-10-20', 'and the rider is shown the day the arena is actually on');
  is(r.lbData.today.length, 0, 'whose Today tab is empty, not yesterday evening under the word Today');
  await beats(r, 180);
  is(r.asks, 1, 'and an hour of beats on the new day costs nothing further');

  // the way out the other side: a device whose clock is a day off the arena never agrees with the
  // board that lands, so a bare comparison would re-ask on every beat for the whole visit
  const skew = menu(board('2026-10-19', was));
  skew.day = '2026-11-30';                    // a clock a month out
  skew.answer = lands(board('2026-10-19', was));
  await beats(skew, 180);
  is(skew.asks, 1, 'a wrong clock is worth one ask, not one a beat for an hour');

  // red against the gate this replaced
  const flat = menu(board('2026-10-19', was),
    'const menuPoll = () => { liveCount(); if (!lbData || lbStale) loadTop(); };');
  flat.day = '2026-10-20';
  flat.answer = lands(board('2026-10-20', []));
  await beats(flat, 180);
  is(flat.asks, 0, 'the gate this replaced never noticed the day turn over');
  is(flat.lbData.today.length, 1, 'and left yesterday sitting under a tab reading Today');
}

// ---- a storage fault costs the row it was writing and nothing else ----
// The referee makes two storage calls from INSIDE the tick - the score write in kill() and the board
// read riderName() does for a rider who typed no name - and neither was guarded. The read is the one
// that bricked the arena: it runs on every anonymous join, a throw there aborted step() BEFORE any bike
// moved, and a socket still waiting for a seat is never hung up, so the same crash came round on every
// tick for as long as anyone stayed. Measured 2026-10-21 on the real referee: 60 ticks out of 60
// aborted and not one bike moved in six seconds, while the tick counter went on climbing and /count and
// /top went on answering 200 - the exact "answers but cannot be played" hole live-pulse exists to catch.
{
  const quiet = console.error; console.error = () => {};
  const throwing = re => {
    const feed = [];
    const sql = {exec: q => { if (re.test(q)) throw new Error('SQLITE_FULL'); return []; }};
    const a = new Arena({storage: {sql}});
    const real = a.spawn.bind(a);
    a.spawn = (n, bot) => bot ? null : real(n, bot);   // no bots hunting the test bike
    a.socks.add({ws: {send: t => feed.push(JSON.parse(t))}, bike: {alive: true}, count: 0, windowAt: Date.now()});
    a.feed = feed;
    return a;
  };
  const ticks = (a, n) => { let dead = 0; for (let i = 0; i < n; i++) try { a.step(); } catch (e) { dead++; } return dead; };

  // the read: an anonymous rider waiting for a seat while the board cannot be read
  const r = throwing(/^SELECT DISTINCT/);
  const {b: on} = rider(r, 'NAMED', 2, 2, 'R');
  const waiter = {ws: {send() {}}, bike: null, count: 0, windowAt: Date.now(), waiting: ''};
  r.socks.add(waiter);
  is(ticks(r, 5), 0, 'a board the referee cannot read does not abort the tick');
  is(on.x - 2, 5, 'so the riders already in the arena keep moving');
  assert(waiter.bike && /^RIDER/.test(waiter.bike.name), 'and the rider who typed no name is still given one and seated');
  is(r.lost, 1, 'the fault is counted rather than swallowed');

  // the write: a rider who scored, whose row cannot be stored
  const w = throwing(/^INSERT INTO runs/);
  const {b: doomed} = rider(w, 'DOOM', 12, 20, 'L');   // 12 cells of road, so the run is worth a point
  const {b: other} = rider(w, 'BYST', 2, 40, 'R');
  is(ticks(w, 20), 0, 'a score the referee cannot store does not abort the tick either');
  assert(!doomed.alive, 'the rider is still knocked out');
  is(other.x - 2, 20, 'and everyone else rides on through the tick it failed on');
  is(w.feed.length, 20, 'no rider loses a tick of the arena over it');
  is(w.lost, 1, 'and the lost run is counted, because a run lost with no trace is the silent kind');
}

// ---- and a storage fault on the REQUEST path answers a refusal, not a 500 nobody can read ----
// The guards above cover the two calls inside step(). The other four are on the request path - the board
// read behind /top, the note write behind /say, and the two admin lists - and a throw there does not
// land in the tick at all: it lands in the Durable Object fetch handler, which Cloudflare turns into a
// 500 of its own HTML with none of the CORS headers these paths set. Measured 2026-10-22 on the real
// referee with a store that throws: /top, /say and /board all threw straight out of fetch() and
// this.lost stayed 0, so the fault left no trace anywhere while /count went on answering on:0. The page
// is not the problem - it already reads both a refusal and a dropped request as failure - so what the
// 503 buys is the count admitting it, which is the only way anyone outside the object finds out.
{
  const quiet = console.error; console.error = () => {};
  const broken = re => {
    const sql = {exec: q => { if (re.test(q)) throw new Error('SQLITE_IOERR'); return []; }};
    return new Arena({storage: {sql}});
  };
  const hit = async (a, path, init) => {
    try {
      const r = await a.fetch(new Request('https://arena.test' + path, init));
      return {status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.text()};
    } catch (e) { return {threw: e.message}; }
  };
  const note = {method: 'POST', body: JSON.stringify({body: 'the blade button does nothing'})};

  // the board every menu view asks for, on a store that cannot be read
  const t = broken(/^SELECT name/);
  const top = await hit(t, '/top');
  is(top.threw, undefined, 'a board the referee cannot read does not throw out of fetch()');
  is(top.status, 503, 'the menu is refused rather than sent a 500 page nobody set a header on');
  is(top.cors, '*', 'and the refusal carries the header, so the page reads a status and not a CORS failure');
  is(t.lost, 1, 'the fault is counted');
  const cnt = await hit(t, '/count');
  is(cnt.status, 200, 'the count still answers, because it touches no storage at all');
  is(cnt.body, '{"on":0,"lost":1}', 'and carries the trace - the only way anyone outside ever finds out');

  // a player crash report, on a store that cannot be written
  const s = broken(/^INSERT INTO notes/);
  const said = await hit(s, '/say', note);
  is(said.threw, undefined, 'a note the referee cannot store does not throw out of fetch() either');
  is(said.status, 503, 'the report is refused, which is what gives the page its retry back');
  is(said.cors, '*', 'with the header this endpoint sets on every other answer it gives');
  is(s.lost, 1, 'and the dropped report is counted, because a report filed nowhere is the silent kind');

  // the admin lists, which are the paths Lok himself reads on launch morning
  is((await hit(broken(/^SELECT day/), '/board')).status, 503, 'the board list refuses rather than 500s');
  is((await hit(broken(/^SELECT kind/), '/inbox')).status, 503, 'and so does the inbox');

  // and nothing changed for a healthy arena
  const ok = new Arena({storage: {sql: {exec: () => []}}});
  is((await hit(ok, '/top')).status, 200, 'a working store still answers the board with a 200');
  is((await hit(ok, '/say', note)).body, 'ok', 'and still takes the note');
  is((await hit(ok, '/count')).body, '{"on":0}', 'and the count says nothing about faults that never happened');
  is(ok.lost, 0, 'nothing is counted that did not fail');
  console.error = quiet;
}
console.log(bad ? '\n' + bad + ' FAILED' : '\nall good');
process.exit(bad ? 1 : 0);
