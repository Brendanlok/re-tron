# Saturday's regression list, as one command: python preflight.py
# Every check here is one that has silently drifted before - the itch zip went stale twice on
# 1 Oct without anyone noticing, and the repo rename could have left the preview pointing at a
# dead /tron/ path. Prose in press/launch-copy.md told you to check these; nothing ran them.
import hashlib, sys, urllib.request, zipfile

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

# ponytail: whether the DEPLOYED worker is current is not checkable without wrangler, so it is not
# here. Run it by hand in server/: npx.cmd wrangler deploy  (or deployments list to read the date),
# and compare against: git log -1 --date=iso -- server/src/index.js
print('\n' + ('all good' if not bad else '%d FAILED: %s' % (len(bad), ', '.join(bad))))
sys.exit(1 if bad else 0)
