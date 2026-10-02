# Saturday's regression list, as one command: python preflight.py
# Every check here is one that has silently drifted before - the itch zip went stale twice on
# 1 Oct without anyone noticing, and the repo rename could have left the preview pointing at a
# dead /tron/ path. Prose in press/launch-copy.md told you to check these; nothing ran them.
import datetime, hashlib, re, subprocess, sys, urllib.request, zipfile

LIVE = 'https://brendanlok.github.io/re-tron/'
ARENA = 'https://re-tron.chanlokk97.workers.dev'
ASSETS = ['og.png', 'favicon.svg', 'icon-192.png', 'icon-512.png',
          'icon-maskable-192.png', 'icon-maskable-512.png', 'manifest.json']
bad = []

def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + (' - ' + detail if detail else ''))
    if not ok: bad.append(name)

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

print('\n' + ('all good' if not bad else '%d FAILED: %s' % (len(bad), ', '.join(bad))))
sys.exit(1 if bad else 0)
