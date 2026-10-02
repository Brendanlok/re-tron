// Does the arena stop its clock when the last rider leaves? Run it: node server/idle-stop.mjs [wss://host]
//
// This is the only failure on the list that costs money rather than players. The Durable Object bills
// for wall-clock duration whenever it is awake, and the arena ticks ten times a second, so an arena
// that keeps ticking with nobody connected spends the free allowance on an empty board, all night,
// every night. Nothing visible says so: /count answers {"on":0} either way, the page looks perfect,
// and the first anyone would know is the bill. drop() -> stop() is what prevents it, and the headless
// suite proves it on the local class - but nothing had ever asked the DEPLOYED arena, which is the
// one that spends. Measured live for the first time on 2 Oct: the clock came back at 1 both times.
//
// How it reads the answer: stop() calls reset(), so an arena that hung up and shut down starts its
// clock again from zero. Ride, note the clock, hang up, wait, ride again. Back near zero means it
// stopped. Twelve seconds on means it never did, and is still going.
//
// It cannot touch the board, by the same argument as live-pulse.mjs and with more room to spare: a
// run is written down only when score > 0, score is floor(secs) + 10 * kos, and each of these two
// bikes is let go on its FIRST tick - about a tenth of a second - and never asks for the blade. No
// wall, so no knockout it could own, and floor(0.1) is 0.
const HOST = (process.argv[2] || 'wss://re-tron.chanlokk97.workers.dev').replace(/\/+$/, '');
const http = p => HOST.replace(/^ws/, 'http') + p;
const WAIT = 12000;   // long enough that an arena still ticking has moved ~120, far past any doubt
const NAME = 'the arena stops its clock when the last rider leaves';

const say = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + NAME + ' - ' + msg); process.exit(ok ? 0 : 1); };

// One lap: take a seat, read the clock on the very first tick, hang up at once.
const lap = () => new Promise((res, rej) => {
  const ws = new WebSocket(HOST + '/ws');
  let seat = null;
  const t = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error('nothing came back in 8s')); }, 8000);
  const out = v => { clearTimeout(t); try { ws.close(); } catch (e) {} res(v); };
  ws.onerror = e => { clearTimeout(t); rej(new Error('socket failed: ' + (e.message || e.type))); };
  ws.onclose = () => { clearTimeout(t); rej(new Error('the arena hung up before the bike had ridden')); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return rej(new Error('the arena sent something that is not JSON')); }
    if (m.t === 'hi') return ws.send(JSON.stringify({t: 'join', name: ''}));
    if (m.t === 'full') return out(null);              // busy arena: not this check's business
    if (m.t === 'you') { seat = m.id; return; }
    if (m.t === 'k' && seat !== null) out(m.k);
  };
});

// The verdict, kept apart from the riding so it can be proved on its own. It had to be: a local
// wrangler dev CANNOT reproduce the fault - miniflare suspends the isolate between requests, so a
// scratch copy with stop() neutered still had a clock that barely moved, and this check cheerfully
// said "ok" over it (measured 2 Oct). An end-to-end failure test is therefore not available here,
// and a check nobody has ever seen say no is how the itch-zip check stayed broken for a day. So the
// branch is proved directly instead: node server/idle-stop.mjs --self-check.
export function verdict(a, b, waitMs) {
  const moved = b - a, never = Math.round(waitMs / 100);
  const ok = moved < never / 4;
  return {ok, msg: ok
    ? 'clock ' + a + ' then ' + b + ' across ' + waitMs / 1000 + 's empty, so it shut down and the bill stopped with it'
    : 'clock ' + a + ' then ' + b + ' across ' + waitMs / 1000 + 's with NOBODY connected - it moved ' + moved +
      ' ticks, about the ' + never + ' of an arena that never stopped. This is spending the free allowance on an empty board'};
}

if (process.argv.includes('--self-check')) {
  const assert = await import('node:assert');
  // an arena that shut down and reset: the clock comes back near zero
  assert.default(verdict(1, 1, WAIT).ok, 'a reset clock must read as healthy');
  assert.default(verdict(150, 2, WAIT).ok, 'a clock that went backwards must read as healthy');
  // an arena that never stopped: twelve seconds on, the clock has moved about 120
  assert.default(!verdict(1, 121, WAIT).ok, 'a clock that ran the whole wait must read as broken');
  assert.default(!verdict(40, 160, WAIT).ok, 'and so must one that ran it from any starting point');
  console.log('ok   ' + NAME + ' - self-check: the verdict says yes to a stopped clock and no to a running one');
  process.exit(0);
}

try {
  // A busy arena is MEANT to keep ticking, so asking the question at all would be crying wolf on the
  // one morning it matters. Ask /count first and stand down - this is why the check is safe to leave
  // on the launch-day list rather than something to remember to skip.
  const on = (await (await fetch(http('/count'), {headers: {'user-agent': 'Mozilla/5.0 (re-tron preflight)'}})).json()).on;
  if (on > 0) say(true, 'skipped, ' + on + ' riding - a busy arena is supposed to keep ticking');

  const a = await lap();
  if (a === null) say(true, 'skipped, the arena is full - no seat to test with');

  await new Promise(r => setTimeout(r, WAIT));

  const b = await lap();
  if (b === null) say(true, 'skipped, someone arrived mid-check - a busy arena is supposed to keep ticking');

  const v = verdict(a, b, WAIT);
  say(v.ok, v.msg);
} catch (e) {
  say(false, e.message);
}
