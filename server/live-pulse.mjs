// Does the arena actually PLAY? Run it: node server/live-pulse.mjs [wss://host]
//
// This closes the quietest hole in Sunday's check list. /count and /top answer without ever touching
// step() - that is deliberate, it is what keeps an idle menu free - but it means a referee that throws
// on every tick still serves both of them a cheerful 200, and preflight prints "all good" over an arena
// nobody can ride. Nothing in the list opened a socket, so nothing in the list could tell.
//
// It cannot touch the board, and that is checked in the code rather than hoped for: a run is written
// down only when score > 0, score is floor(secs) + 10 * kos, this bike is let go well inside a second
// (so floor is 0) and never asks for the blade - so it lays no wall, can own no knockout, and scores 0.
// That is why this one may point at the live arena while test-arena.mjs may not.
const host = (process.argv[2] || 'wss://re-tron.chanlokk97.workers.dev').replace(/\/+$/, '');
const HOLD = 600;      // ms in the saddle: six ticks to watch it move, and floor(0.6s) is still 0
const PATIENCE = 8000; // the whole thing, including a cold Durable Object waking up
// The sub-second hold is load-bearing, not a tuning knob: at HOLD >= 1000 the bike scores 1 instead
// of 0 and this probe starts writing a RIDERn run onto the LIVE board on every preflight run - and
// nothing would say so, because the junk-run check matches four names by hand and RIDERn is not one
// of them. So it fails loudly here instead, before a socket is opened. Raising it means scoring 0
// another way (ask the referee not to record, or drop before the first tick like idle-stop.mjs).
if (HOLD >= 1000) throw new Error('live-pulse HOLD must stay under 1000ms - at a second it scores 1 and leaves a RIDERn run on the live board');

let ws, seat = null, ticks = [], seen = [], over = false;

function done(ok, msg) {
  if (over) return;
  over = true;
  try { ws.close(); } catch (e) {}
  console.log((ok ? 'ok   ' : 'FAIL ') + msg);
  process.exit(ok ? 0 : 1);
}
const give = setTimeout(() => done(false, 'the arena seats a bike and rides it - nothing came back in ' +
  PATIENCE / 1000 + 's' + (ticks.length ? '' : ', and not one tick was broadcast')), PATIENCE);
give.unref?.();

// What the hold proves, once it is up: the referee is not merely answering, it is running.
function finish() {
  const n = ticks.length;
  if (!n) return done(false, 'the arena took the bike and then never ticked - ' +
    'the referee is seated but not riding, which is a dead arena wearing a healthy face');
  const rising = ticks.every((k, i) => i === 0 || k > ticks[i - 1]);
  const moved = seen.length > 1 && seen.some(p => p !== seen[0]);
  if (!rising) return done(false, 'the arena ticked but the clock did not advance - ' + ticks.join(','));
  if (!moved) return done(false, 'the arena ticked ' + n + ' times and the bike never moved from ' + seen[0]);
  done(true, 'the arena seats a bike and rides it - ' + n + ' ticks, moved ' + seen[0] + ' to ' + seen[seen.length - 1]);
}

try { ws = new WebSocket(host + '/ws'); } catch (e) { done(false, 'the arena seats a bike and rides it - ' + e.message); }
ws.onerror = e => done(false, 'the arena seats a bike and rides it - socket failed: ' + (e.message || e.type));
ws.onclose = () => done(false, 'the arena hung up before the bike had ridden' +
  (seat === null ? ' - it never gave one a seat' : ''));
ws.onmessage = ev => {
  let m; try { m = JSON.parse(ev.data); } catch (e) { return done(false, 'the arena sent something that is not JSON'); }
  if (m.t === 'hi') return ws.send(JSON.stringify({t: 'join', name: ''}));   // blank: the referee names it RIDERn
  // A full arena is not a broken one. Say so plainly rather than crying wolf on the one day it is busy.
  if (m.t === 'full') return done(true, 'the arena is up and FULL (' + m.on + ' riding) - no seat to test with, ' +
    (ticks.length ? ticks.length + ' ticks seen, so it is riding' : 'and no tick was seen either - run it again'));
  if (m.t === 'you') { seat = m.id; seen.push(m.b[1] + ',' + m.b[2]); return void setTimeout(finish, HOLD); }
  if (m.t !== 'k') return;
  if (seat === null) return;                 // still waiting for room; the clock is proof enough on its own
  ticks.push(m.k);
  const mine = m.b.find(b => b[0] === seat);
  if (mine) seen.push(mine[1] + ',' + mine[2]);
};
