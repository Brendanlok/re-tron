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
  a.socks.add({ws: {send: t => feed.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now()});
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
  is(a.bikes.size, 6, 'bots top the arena up to six bikes');
  assert([...a.bikes.values()].every(b => b.bot), 'and they are all bots when nobody has joined');
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

console.log(bad ? '\n' + bad + ' FAILED' : '\nall good');
process.exit(bad ? 1 : 0);
