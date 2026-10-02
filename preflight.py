# Saturday's regression list, as one command: python preflight.py
# Every check here is one that has silently drifted before - the itch zip went stale twice on
# 1 Oct without anyone noticing, and the repo rename could have left the preview pointing at a
# dead /tron/ path. Prose in press/launch-copy.md told you to check these; nothing ran them.
import datetime, hashlib, json, re, subprocess, sys, urllib.request, zipfile

LIVE = 'https://brendanlok.github.io/re-tron/'
ARENA = 'https://re-tron.chanlokk97.workers.dev'
ASSETS = ['og.png', 'favicon.svg', 'icon-192.png', 'icon-512.png',
          'icon-maskable-192.png', 'icon-maskable-512.png', 'manifest.json']
bad = []

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + (' - ' + detail if detail else ''))
    if not ok: bad.append(name)

# The one launch-day job that has only ever been prose: the all-time board a first visitor sees is
# four runs nobody played, and the best of them says the record is twenty seconds. Written down on
# 23 Sep, and it has DRIFTED since without anyone noticing - two rows then, four now - which is how
# a to-do that nothing runs gets forgotten. The wipe needs the ADMIN key, so it stays Lok's to run;
# this only makes sure he cannot reach Sunday without being told. The verdict is split out so both
# halves can be asserted, the way idle-stop.mjs is - the live board can only ever show the one half.
LAUNCH = datetime.date(2026, 10, 4)
JUNK = [['SDF', 29, 19.6, 1], ['TEST', 21, 21.6, 0], ['LOK', 7, 7.8, 0], ['TWO', 1, 1.4, 0]]
todo = []

def board_todo(rows, today):
    # Matched on all four fields, not on the name: LOK is a name a real player may well ride under.
    return [r for r in rows if list(r) in JUNK], today >= LAUNCH

# runs before the network checks, so proving it costs nothing: python preflight.py --self-check
if '--self-check' in sys.argv:
    assert board_todo(JUNK, datetime.date(2026, 10, 3)) == (JUNK, False), 'junk before launch day is not fatal'
    assert board_todo(JUNK, LAUNCH) == (JUNK, True), 'junk ON launch day is fatal'
    assert board_todo([['REAL', 40, 30.0, 1]], LAUNCH) == ([], True), 'a real run is not junk'
    assert board_todo([], LAUNCH) == ([], True), 'a clean board is clean'
    print('ok   board_todo: finds the junk, spares a real run, and only turns fatal on launch day')
    sys.exit(0)

# Cloudflare's bot protection sits in front of the arena and turns Python-urllib away with a 403
# while it serves curl and every browser a 200 (measured 1 Oct; there is no user-agent check
# anywhere in server/src/index.js - the only 403 it can raise itself is the ADMIN path). Ask as a
# browser, or this reports the arena down on a launch morning when it is perfectly healthy.
UA = {'user-agent': 'Mozilla/5.0 (re-tron preflight)'}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read()

sha = lambda b: hashlib.sha256(b).hexdigest()[:12]
here = open('index.html', 'rb').read()

# 1. the link serves the page in this repo, not a push that never landed
try:
    st, live = get(LIVE)
    check('the live link is the page in this folder', st == 200 and live == here,
          '%d, live %s / repo %s' % (st, sha(live), sha(here)))
except Exception as e:
    check('the live link is the page in this folder', False, repr(e))

# 2. the file in itch's upload box is that same page
try:
    z = zipfile.ZipFile('press/re-tron.zip').read('index.html')
    check('the itch zip is that same page', z == here,
          'zip %s / repo %s' % (sha(z), sha(here)) + ('' if z == here else ' - repack it, see press/launch-copy.md'))
except Exception as e:
    check('the itch zip is that same page', False, repr(e))

# 3. the preview and the icons resolve - a rename leaves these pointing at a 404
for a in ASSETS:
    try:
        st, b = get(LIVE + a)
        check('%s is served' % a, st == 200 and len(b) > 0, '%d, %db' % (st, len(b)))
    except Exception as e:
        check('%s is served' % a, False, repr(e))

# 4. the arena answers the menu's two questions, and neither starts the tick
for p, key in (('/count', 'on'), ('/top', 'all')):
    try:
        st, b = get(ARENA + p)
        check('the arena answers %s' % p, st == 200 and key.encode() in b, '%d %s' % (st, b[:60].decode('utf8', 'replace')))
    except Exception as e:
        check('the arena answers %s' % p, False, repr(e))

# 5. the deployed arena is the server in this folder. This is the quietest failure of the lot: a
# stale Worker serves a page that looks perfect and plays by last week's rules, and nothing on the
# screen says so. Compared by date, not by contents - wrangler knows when it last deployed, git
# knows when the server last changed - which catches the whole class without needing a build.
SERVER = ['server/src/index.js', 'server/wrangler.toml']

def sh(*a, **kw):
    # wrangler prints glyphs Windows' default cp1252 cannot decode, and a failed decode hands back
    # None instead of the listing - so the encoding is named rather than left to the console's.
    return subprocess.run(a, capture_output=True, encoding='utf8', errors='replace', timeout=180, **kw)

def when(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))

try:
    # Uncommitted server edits can't have been deployed, whatever the dates say.
    dirty = sh('git', 'status', '--porcelain', '--', *SERVER).stdout.strip()
    changed = max(sh('git', 'log', '-1', '--format=%cI', '--', f).stdout.strip() for f in SERVER)
    out = sh('npx.cmd', 'wrangler', 'deployments', 'list', cwd='server').stdout
    # Deployments sit at the left margin; the versions nested under them are indented.
    stamps = re.findall(r'^Created:\s+(\S+)', out, re.M)
    if not stamps:
        check('the deployed arena is the server in this folder', False,
              'wrangler would not say - run it by hand in server/: npx.cmd wrangler deployments list')
    else:
        live = max(when(x) for x in stamps)
        check('the deployed arena is the server in this folder',
              not dirty and live > when(changed),
              'deployed %s, server last changed %s' % (live.strftime('%Y-%m-%d %H:%M UTC'),
                  when(changed).astimezone(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))
              + (' - uncommitted: ' + ', '.join(x.strip() for x in dirty.splitlines()) if dirty else '')
              + ('' if not dirty and live > when(changed) else ' - deploy it: cd server, then npx.cmd wrangler deploy'))
except Exception as e:
    check('the deployed arena is the server in this folder', False, repr(e))

# 6. the arena does not merely answer - it PLAYS. Checks 4 and 5 are both satisfied by a referee that
# throws on every tick: /count and /top never touch step() (deliberately - it is what keeps an idle menu
# free), so they serve a cheerful 200 over a dead arena and this whole list reads "all good" while nobody
# can ride. Proved it on 2 Oct by throwing from step() on a local wrangler dev: /count 200, /top 200 with
# a full board, and this the only check that noticed. It cannot dirty the board - see live-pulse.mjs.
try:
    r = sh('node', 'server/live-pulse.mjs', ARENA.replace('https://', 'wss://'))
    out = (r.stdout or r.stderr or '').strip().splitlines()
    said = out[-1] if out else 'the arena seats a bike and rides it - live-pulse said nothing at all'
    # it prints its own ok/FAIL line in this script's format, so pass it straight through rather than
    # wrapping it and saying the name of the check twice
    print(said if said.startswith(('ok ', 'FAIL ')) else 'FAIL ' + said)
    if r.returncode != 0: bad.append('the arena seats a bike and rides it')
except Exception as e:
    check('the arena seats a bike and rides it', False, repr(e))

# 7. the arena SHUTS DOWN when the last rider leaves. The only failure on this list that costs money
# rather than players: the Durable Object bills for wall-clock time whenever it is awake and the arena
# ticks ten times a second, so one that keeps ticking on an empty board spends the free allowance all
# night and nothing visible says so - /count answers {"on":0} either way. The headless suite proves
# drop() -> stop() on the local class, but that cannot see the WIRING: a real socket closing, in the
# real runtime, reaching drop() at all. This asks the deployed arena, which is the one that spends.
# It stands down on its own when anyone is riding, so it is safe to leave on the launch-day list.
try:
    r = sh('node', 'server/idle-stop.mjs', ARENA.replace('https://', 'wss://'))
    out = (r.stdout or r.stderr or '').strip().splitlines()
    said = out[-1] if out else 'the arena stops its clock when the last rider leaves - idle-stop said nothing at all'
    print(said if said.startswith(('ok ', 'FAIL ')) else 'FAIL ' + said)
    if r.returncode != 0: bad.append('the arena stops its clock when the last rider leaves')
except Exception as e:
    check('the arena stops its clock when the last rider leaves', False, repr(e))

# 8. the pre-launch test runs are off the all-time board. Cheap and tick-free: /top is the same path
# the menu already asks, so this adds one read and wakes nothing. See board_todo at the top.
try:
    st, b = get(ARENA + '/top')
    left, fatal = board_todo(json.loads(b)['all'], datetime.date.today())
    name = 'the pre-launch test runs are off the board'
    shown = ', '.join('%s %d' % (r[0], r[1]) for r in left)
    wipe = ' - wipe before announcing: POST %s/board?wipe=1 with the ADMIN key' % ARENA
    if not left: check(name, True, 'nothing but real runs on it')
    elif fatal: check(name, False, shown + wipe)
    else:
        print('TODO ' + name + ' - still up: ' + shown + wipe)
        todo.append(name)
except Exception as e:
    check('the pre-launch test runs are off the board', False, repr(e))

print('\n' + ('all good' if not bad else '%d FAILED: %s' % (len(bad), ', '.join(bad))))
if todo: print('still to do before Sunday: ' + '; '.join(todo))
sys.exit(1 if bad else 0)
