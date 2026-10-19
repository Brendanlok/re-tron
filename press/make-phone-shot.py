"""Re-take press/shot-1-arena-phone.png and press/shot-2-knockout-phone.png from whatever index.html draws.

Run it from the repo root: python press/make-phone-shot.py          (both shots)
                           python press/make-phone-shot.py 2        (just the knockout one)

These two were the last press images that could not be regenerated. They were shot by hand on 30 Sep,
and the in-arena top-riders panel in them was TYPED IN next to a HUD the page computes - two sources
for one number. It went stale exactly the way that always ends: shot-2 was retimed to 141.6 alive and
5 knockouts, which is 191 by the game's own rule, and its panel still read 158 - the figure that had
been right for shot-1. Off by 33 on the image the kit calls its strongest. Here your row is worked out
from myStart and myKos the way the referee works it out, and the rows sort themselves after it, so the
picture cannot disagree with itself again.

How it works, the same way press/make-wide-shot.py and press/make-menu-shot.py do: index.html is copied
to a scratch probe with requestAnimationFrame stubbed out, fetch left pending (nothing touches the live
arena) and isTouch forced true, a hand-built arena is appended - no server, no socket - and headless Edge
is asked for one screenshot at a phone's size. Quirks handled, all measured:
  * HEADLESS EDGE IGNORES --window-size FOR THE LAYOUT VIEWPORT. Measured today at 300, 320, 360, 390 and
    500 wide: every one laid the page out at 484x752 CSS, while --screenshot still wrote window-size x2
    device pixels. So a phone-sized capture of a 484-wide page cut the right-hand third off - the first
    take of this script lost the top-riders scores and half the BLADE button. The two older scripts never
    noticed because what they shoot is centred. The fix is not to fight the window: everything is moved
    into a 390x844 box with a transform on it, which makes that box - not the viewport - what the HUD,
    the board, the pad and the BLADE button measure "fixed" against. --pad and --bl are pinned with it,
    because they are written in vw and vw still means the viewport.
  * Edge does not composite a canvas into --screenshot, so the probe hands it a plain <img> of the same
    pixels (cv.toDataURL) BEHIND the controls, and hides the canvas. The pad and BLADE button are DOM.
  * Back-to-back Edge runs write nothing at all, roughly every other try, hence the retry loop.
  * Math.random is seeded before the derez, so the shards land in the same places every run and a
    re-shoot is a re-shoot rather than a new picture.

The knockout shot needs more than the mid-run one: it is a moment, not a pose, so it seeds the derez
through the page's own derez() and then steps the page's own frame() a third of a second so the cubes
have flown and the ring has raced out. Nothing about the effect is re-implemented here.
"""
import os, shutil, subprocess, sys, tempfile, time

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSS_W, CSS_H, SCALE = 390, 844, 2     # 780x1688, the size of the two files this replaces

# A phone-sized box for the page to live in, because the real viewport is whatever Edge feels like.
# A transform on it makes it the containing block for everything position:fixed inside, so the HUD at
# the top and the pad and BLADE button at the foot land where they land on a 390px phone. --pad and --bl
# are vw, which a transform does not touch, so they are restated here at 46% and 30% of 390.
FRAME = """
<style>
  html, body { margin: 0; overflow: hidden; background: #070a10; }
  :root { --pad: 179.4px; --bl: 117px; }
  #shotframe { position: fixed; left: 0; top: 0; width: %(w)dpx; height: %(h)dpx;
               overflow: hidden; background: #070a10; transform: translateZ(0); }
</style>
<script>
addEventListener('DOMContentLoaded', function () {
  const fr = document.createElement('div');
  fr.id = 'shotframe';
  document.body.append(fr);
  while (document.body.firstChild !== fr) fr.append(document.body.firstChild);
});
</script>
""" % {"w": CSS_W, "h": CSS_H}

# Shared by both scenes: the arena you are riding in, six bikes, two of them with nothing behind them
# because the blade is off - which is the whole game and the reason both shots keep them.
COMMON = """
  const cell = (x, y) => y * W + x;
  let born = 0;
  function trail(id, x, y, legs) {
    for (const [dx, dy, n] of legs) for (let i = 0; i < n; i++) { walls.set(cell(x, y), {o: id, born: born++}); x += dx; y += dy; }
    return [x, y];
  }
  function bike(id, nm, x, y, d, blade, charge) {
    bikes.set(id, {id, x, y, px: x, py: y, ox: x, oy: y, d, blade, charge});
    names.set(id, {n: nm, bot: id !== 1 ? 1 : 0});
  }
  tick = 2400; tickAt = performance.now();
  ws = {};                                   // rivals' names only draw for a real arena
  me = 1; riding = true;
  let seed = 90210;
  Math.random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
"""

# Your row is COMPUTED, never typed: score = whole seconds alive + 10 per knockout, read off the same
# myStart and myKos the HUD above it reads. A hand-written number here is a second source for one number
# and goes stale the moment the scene is retimed - which is what put 158 on a 191 picture.
SHOW = """
  const mine = Math.floor((tick - myStart) / 10) + 10 * myKos;
  paintBoard(RIVALS.concat([['YOU', mine, 0]]).sort((a, b) => b[1] - a[1]).slice(0, 3));
  $('overlay').hidden = true;
  $('hud').hidden = $('board').hidden = $('blade').hidden = $('pad').hidden = false;
  $('hint').hidden = true;                   // on a phone the hint is empty: the BLADE button says it
  dpr = %(scale)d; cw = %(w)d; ch = %(h)d;
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  cv.width = cw * dpr; cv.height = ch * dpr;
  paint();
  for (let f = 0; f <= STEPS; f++) frame(f * 16);   // the page's own loop: ages the shards and the ring
  draw();
  const img = new Image();
  img.src = cv.toDataURL('image/png');
  img.style.cssText = 'position:fixed;left:0;top:0;width:' + cw + 'px;height:' + ch + 'px;z-index:0';
  cv.style.display = 'none';
  document.getElementById('shotframe').prepend(img);
""" % {"scale": SCALE, "w": CSS_W, "h": CSS_H}

# shot-1: mid-run. Your ribbon comes in along the bottom and turns up under you, a red rival is driving
# straight down at it from above, and two riders are carrying nothing at all.
SHOT1 = """
  myStart = tick - 1183; myKos = 4;          // 118.3 alive + 4 knockouts = 158
  const RIVALS = [['ZED', 204, 1], ['ORA', 131, 1], ['MOX', 96, 1], ['KIT', 74, 1]];
  const STEPS = 0;
  born = tick - 55; let p = trail(1, 26, 36, [[-1, 0, 6], [0, -1, 6]]);
  bike(1, 'YOU', p[0], p[1], 'U', true, 71);
  born = tick - 50; p = trail(1005, 17, 14, [[0, 1, 8]]);    // ORA, red, coming down at your ribbon
  bike(1005, 'ORA', p[0], p[1], 'D', true, 44);
  born = tick - 46; p = trail(1004, 34, 27, [[-1, 0, 10]]);  // ZED, amber, crossing from the right
  bike(1004, 'ZED', p[0], p[1], 'L', true, 62);
  born = tick - 24; p = trail(1007, 10, 42, [[1, 0, 6]]);    // MOX, mint, along the bottom left
  bike(1007, 'MOX', p[0], p[1], 'R', true, 85);
  bike(1006, 'KIT', 24, 34, 'D', false, 100);                // blade off: nothing behind him at all
  bike(1002, 'VEX', 14, 20, 'U', false, 53);
"""

# shot-2: the moment a rival rides into your wall and comes apart. Seeded through the page's own derez()
# at the oldest end of your ribbon - the end a rival chasing you from behind would reach first - and his
# own wall is gone, because a knocked-out rider's wall goes with him.
SHOT2 = """
  myStart = tick - 1416; myKos = 5;          // 141.6 alive + 5 knockouts = 191
  const RIVALS = [['ZED', 204, 1], ['ORA', 131, 1], ['MOX', 96, 1]];
  const STEPS = 15;                          // ~0.24s: the cubes have flown and the ring is still bright
  born = tick - 55; let p = trail(1, 12, 36, [[1, 0, 8], [0, -1, 6]]);
  bike(1, 'YOU', p[0], p[1], 'U', true, 58);
  born = tick - 44; p = trail(1004, 32, 24, [[-1, 0, 11]]);  // ZED, amber, across the top
  bike(1004, 'ZED', p[0], p[1], 'L', true, 66);
  born = tick - 20; p = trail(1007, 22, 40, [[1, 0, 5]]);    // MOX, mint, away to the lower right
  bike(1007, 'MOX', p[0], p[1], 'R', true, 81);
  bike(1006, 'KIT', 15, 27, 'D', false, 100);                // blade off: nothing behind him
  bike(1002, 'VEX', 13, 21, 'D', false, 47);
  // ORA came down onto the ribbon you had just laid, four cells behind you - close enough that the
  // ring and the cubes sit inside the frame rather than half off the left edge, which is where a
  // crash at the far end of the wall put them.
  derez(16, 36, PALETTE[1005 % PALETTE.length], 'D');
"""

SHOTS = {
    "1": ("shot-1-arena-phone.png", "_probe_phone1.html", SHOT1),
    "2": ("shot-2-knockout-phone.png", "_probe_phone2.html", SHOT2),
}


def shoot(key):
    name, probe_name, scene = SHOTS[key]
    out = os.path.join(HERE, name)
    probe = os.path.join(ROOT, probe_name)
    page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    if page.count("<script>") != 1:
        sys.exit("index.html no longer has exactly one <script> block - check the probe still fits")
    if page.count("const isTouch =") != 1:
        sys.exit("index.html no longer declares isTouch once - check the probe still fits")
    page = page.replace("<script>", "<script>requestAnimationFrame = () => 0; fetch = () => new Promise(() => {});", 1)
    page = page.replace("const isTouch =", "const isTouch = true ||", 1)   # a phone: the pad and the BLADE button
    page = page.replace("</body>", FRAME + "<script>setTimeout(function () {" + COMMON + scene + SHOW + "}, 1200);</script></body>", 1)
    open(probe, "w", encoding="utf-8", newline="").write(page)
    profiles = tempfile.mkdtemp(prefix="retron-shot-")   # not under ROOT: these must never land in the repo
    try:
        if os.path.exists(out):
            os.remove(out)
        for i in range(6):
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=%d,%d" % (CSS_W, CSS_H),
                            "--force-device-scale-factor=%d" % SCALE,
                            "--screenshot=" + out, "--virtual-time-budget=6000",
                            "--user-data-dir=%s" % os.path.join(profiles, str(i)),
                            "file:///" + probe.replace(os.sep, "/")], capture_output=True)
            if os.path.exists(out):
                print("wrote %s (%d bytes) on try %d" % (out, os.path.getsize(out), i + 1))
                return
            time.sleep(3)
        sys.exit("Edge wrote no screenshot for %s in six tries" % name)
    finally:
        os.path.exists(probe) and os.remove(probe)
        shutil.rmtree(profiles, ignore_errors=True)


for k in (sys.argv[1:] or ["1", "2"]):
    shoot(k)
