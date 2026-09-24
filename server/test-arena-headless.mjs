// Deterministic arena test: import the referee and drive step() by hand, with no network and
// (mostly) no bots. The live smoke test in test-arena.mjs can only check the charge rule when the
// test bike happens to survive six hunting bots; here nothing is hunting it, so the rule that sets
// the whole balance of the game gets checked on every run. Everything is read out of the broadcast
// the riders actually receive, so this checks what players are told, not just the server's own state.
import {Arena} from './src/index.js';

let bad = 0;
const assert = (c, m) => { if (c) console.log('ok   ', m); else { console.log('FAIL ', m); bad++; } };
const is = (got, want, m) => assert(got === want, m + ' (' + got + (got === want ? '' : ', wanted ' + want) + ')');

// The Durable Object hands the Arena a SQLite handle; a list of rows stands in for it. Reads come
// back empty, which is fine - top() is only reached through fetch(), which this test never calls.
function arena({bots = false} = {}) {
  const runs = [], feed = [];
  const a = new Arena({storage: {sql: {exec: (q, ...args) => { if (/^INSERT/.test(q)) runs.push(args); return []; }}}});
  Object.assign(a, {runs, feed});
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

  a.drop(seated[0].s);
  is(a.bikes.size, 11, 'a rider leaving takes their bike with them');
  assert(joiner('P14').said().includes('you'), 'and the seat that frees up goes to the next rider');
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

console.log(bad ? '\n' + bad + ' FAILED' : '\nall good');
process.exit(bad ? 1 : 0);
