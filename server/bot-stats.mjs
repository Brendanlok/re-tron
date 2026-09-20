// How lively is an arena of nothing but bots? Most players arrive to one, so that first minute is
// the whole first impression. Runs the referee headlessly - no network, no browser - and reports
// how often bikes go down, what takes them down, and how long they last.
// Measured 20 Sep over 5 runs of 10 arena-minutes each: about 4 knockouts a minute, roughly half of
// them a bot riding into its own blade, median life around 50s with a tail past 5 minutes.
// Run before and after any change to think(): one run is noisy, five tell you something.
import {Arena} from './src/index.js';

const MINUTES = Number(process.argv[2] || 10), TICKS = MINUTES * 600;
const a = new Arena({storage: {sql: {exec: () => []}}});
const feed = [];
a.socks.add({ws: {send: t => feed.push(JSON.parse(t))}, bike: null, count: 0, windowAt: Date.now()});
for (let i = 0; i < TICKS; i++) a.step();

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
console.log('blade          ' + (feed.flatMap(m => m.a || []).length / TICKS).toFixed(2) + ' cells laid per tick across the arena');
