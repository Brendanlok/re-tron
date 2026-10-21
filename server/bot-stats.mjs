// How lively is an arena of nothing but bots? Most players arrive to one, so that first minute is
// the whole first impression. Runs the referee headlessly - no network, no browser - and reports
// how often bikes go down, what takes them down, and how long they last.
// Measured 21 Oct over 6 runs of 10 arena-minutes each: 2.8-3.5 knockouts a minute (median 3.2, so one
// every 19s), about a third of them a bot riding into its own blade, median life 50-105s with a tail
// past 6 minutes, and a tick costing 0.3ms of its 100ms.
// The baseline this replaces was taken on 20 Sep and read 4 a minute with HALF the knockouts self-
// inflicted. It went stale three days later and stayed wrong for a month: 017ab60 on 23 Sep stopped
// bots riding into loops they had just closed, so the self-blade share fell by half and the arena is
// quieter because that fix works, not because anything regressed. Re-measure here when think() changes,
// or the next reading gets judged against a number from before the last fix.
// Run before and after any change to think(): one run is noisy, five tell you something.
import {Arena} from './src/index.js';

const MINUTES = Number(process.argv[2] || 10), TICKS = MINUTES * 600;
const a = new Arena({storage: {sql: {exec: () => []}}});
const feed = [];
a.socks.add({ws: {send: t => feed.push(JSON.parse(t))}, bike: {alive: true}, count: 0, windowAt: Date.now()});
// What a tick COSTS, not just what it produces. think() is a flood fill per bot per tick, so it is
// the one piece of the referee that can grow expensive without anyone noticing - and a tick that
// overruns its 100ms slot does not fail, it drifts, which every rider sees as the arena stuttering.
// Measured here rather than guessed: run this before and after any change to think().
const cost = [];
for (let i = 0; i < TICKS; i++) {
  const t0 = process.hrtime.bigint(); a.step();
  cost.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
cost.sort((x, y) => x - y);
const ms = p => cost[Math.min(cost.length - 1, Math.floor(cost.length * p))].toFixed(2);

const out = feed.flatMap(m => m.e || []).filter(e => e[2] !== 'left');
const by = r => out.filter(e => e[2] === r).length;
const lives = out.map(e => e[4] / 10).sort((x, y) => x - y);
const at = p => lives[Math.floor(lives.length * p)];
console.log(MINUTES + ' arena-minutes, ' + a.bikes.size + ' bikes riding at the end');
console.log('knockouts      ' + out.length + '  (' + (out.length / MINUTES).toFixed(1) + ' a minute, one every ' +
  (60 * MINUTES / out.length).toFixed(0) + 's)');
console.log('  own blade    ' + by('self') + '   nobody scores for these');
console.log('  someone else ' + (by('wall') + by('head')) + '   (' + by('wall') + ' ridden into, ' + by('head') + ' head-on)');
console.log('  the edge     ' + by('edge'));
console.log('life           median ' + at(.5) + 's   p10 ' + at(.1) + 's   p90 ' + at(.9) + 's   longest ' + lives[lives.length - 1] + 's');
console.log('tick           median ' + ms(.5) + 'ms   p99 ' + ms(.99) + 'ms   worst ' +
  cost[cost.length - 1].toFixed(2) + 'ms   out of the 100ms a tick gets');
console.log('blade          ' + (feed.flatMap(m => m.a || []).length / TICKS).toFixed(2) + ' cells laid per tick across the arena');
