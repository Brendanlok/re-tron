// Smoke test for the Detron arena server: two players, blade charge cycle, crashes, leaving.
const URL_ = process.argv[2] || 'ws://localhost:8787/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

function client(name) {
  const ws = new WebSocket(URL_), c = {ws, ticks: [], you: null, hi: null, events: [], names: new Map()};
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'hi') { c.hi = m; for (const [id, n] of m.names) c.names.set(id, n); }
    if (m.t === 'you') c.you = m.id;
    if (m.t === 'k') { c.ticks.push(m); (m.n || []).forEach(([id, n]) => c.names.set(id, n)); (m.e || []).forEach(e => c.events.push(e)); }
  };
  c.open = new Promise(r => ws.onopen = r);
  c.send = m => ws.send(JSON.stringify(m));
  c.me = () => { const t = c.ticks[c.ticks.length - 1]; return t && t.b.find(b => b[0] === c.you); };
  return c;
}

const A = client('A'); await A.open; await sleep(300);
assert(A.hi && A.hi.W === 40 && A.hi.H === 60, 'hello arrives with the arena size');
A.send({t: 'join', name: 'lok!!'}); await sleep(1500);
assert(A.you > 0, 'join gives an id');
assert(A.names.get(A.you) === 'LOK', 'name is cleaned to LOK');
const last = A.ticks[A.ticks.length - 1];
assert(A.ticks.length >= 10 && A.ticks.length <= 20, 'about 10 ticks a second (' + A.ticks.length + ' in 1.5s)');
assert(last.b.length >= 2, 'bots join the arena (' + last.b.length + ' bikes)');

// blade: full charge lasts ~3s, then 1s at zero, then recharges
const alive = () => !A.events.some(e => e[0] === A.you);
A.send({t: 'blade', on: true});
const seen = [];
const DIRN = ['U', 'D', 'L', 'R'];
for (let i = 0; i < 45 && alive(); i++) {
  await sleep(100);
  const me = A.me(); if (!me) break;
  seen.push([me[4], me[5]]);
  const [, x, y, d] = me;                                   // keep off the edges so the charge test can finish
  if (x < 4 || x > 35) A.send({t: 'turn', d: y < 30 ? 'D' : 'U'});
  else if (y < 4 || y > 55) A.send({t: 'turn', d: x < 20 ? 'R' : 'L'});
  else if (i % 7 === 0) A.send({t: 'turn', d: DIRN[(DIRN.indexOf(DIRN[d]) + 1) % 4]});
}
if (alive()) {
  const firstOff = seen.findIndex(([on], i) => i > 3 && !on);
  assert(firstOff >= 25 && firstOff <= 36, 'blade runs out after ~3s (' + firstOff + ' ticks)');
  const zeros = seen.slice(firstOff).filter(([, ch]) => ch === 0).length;
  assert(zeros >= 8, 'charge waits at zero before recharging (' + zeros + ' ticks)');
  const walls = A.ticks.flatMap(t => t.a || []).filter(([, o]) => o === A.you).length;
  assert(walls >= 25, 'blade laid a barricade (' + walls + ' cells)');
} else console.log('skip  blade timing: crashed during it');

// steer into the edge and check the crash is reported
for (let i = 0; i < 80 && alive(); i++) { A.send({t: 'turn', d: i % 20 < 10 ? 'U' : 'L'}); await sleep(100); }
const ev = A.events.find(e => e[0] === A.you);
assert(ev, 'crash is reported (' + (ev && ev[2]) + ')');

// a second player sees the first; leaving removes the bike
const B = client('B'); await B.open; await sleep(200);
A.send({t: 'join', name: 'two'}); B.send({t: 'join', name: 'bee'}); await sleep(800);
assert(B.you && A.ticks[A.ticks.length - 1].b.some(b => b[0] === B.you), 'A sees B riding');
const bid = B.you; B.ws.close(); await sleep(600);
assert(!A.ticks[A.ticks.length - 1].b.some(b => b[0] === bid), 'B leaving removes their bike');
assert(A.events.some(e => e[0] === bid && e[2] === 'left'), 'leaving is reported as left');
A.ws.close();
await sleep(200); process.exit();
