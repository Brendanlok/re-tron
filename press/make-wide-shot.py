"""Re-take press/shot-3-arena-wide.png from whatever index.html currently draws.

Run it from the repo root: python press/make-wide-shot.py

The shot went stale for sixteen days once - it was taken on 30 Sep and the camera changed on
1 Oct, so the picture Lok would have posted at launch showed the arena floating in black that
the fix had removed. This exists so the picture is regenerated from the page rather than
remembered, and so the next look change costs a minute instead of an afternoon.

How it works: index.html is copied to a scratch probe with requestAnimationFrame stubbed out and
a hand-built arena appended - no server, no socket, no randomness - then headless Edge is asked
for one screenshot. Three measured quirks are already handled here:
  * Edge lays the page out at the window size but reports innerWidth/innerHeight smaller, so the
    canvas is sized to a fixed 1280x720 rather than to fit().
  * Edge does not composite a canvas into --screenshot, so the probe hands it a plain <img> of
    the same pixels (cv.toDataURL) and hides the canvas.
  * Back-to-back Edge runs write nothing at all, roughly every other try, hence the retry loop.
"""
import os, shutil, subprocess, sys, tempfile, time

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROBE = os.path.join(ROOT, "_probe_wide.html")
OUT = os.path.join(HERE, "shot-3-arena-wide.png")

# One still of a real arena: four riders laying ribbon, two riding clean, you in the middle with
# the blade out. The two with nothing behind them are the whole point of the game, so keep them.
SCENE = """
<script>
setTimeout(function () {
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
  tick = 2400; born = tick - 55; tickAt = performance.now();
  ws = {};                                       // rivals' names only draw for a real arena

  let p = trail(1, 11, 38, [[1, 0, 9], [0, -1, 9]]);          // you: a corner in the ribbon behind you
  bike(1, 'YOU', p[0], p[1], 'U', true, 77);
  born = tick - 48; p = trail(1004, 34, 24, [[-1, 0, 12]]);   // ZED, amber, a long wall across the top
  bike(1004, 'ZED', p[0], p[1], 'L', true, 41);
  born = tick - 40; p = trail(1005, 4, 19, [[0, 1, 8], [1, 0, 5]]);   // ORA, red, came down the left
  bike(1005, 'ORA', p[0], p[1], 'R', true, 63);
  born = tick - 20; p = trail(1007, 25, 37, [[1, 0, 7]]);     // MOX, mint, along the bottom right
  bike(1007, 'MOX', p[0], p[1], 'R', true, 88);
  bike(1006, 'KIT', 30, 31, 'D', false, 100);                 // blade off: nothing behind him at all
  bike(1002, 'VEX', 15, 25, 'U', false, 52);

  me = 1; riding = true; myStart = tick - 2039; myKos = 6;
  paintBoard([['ZED', 204, 1], ['YOU', 158, 0], ['ORA', 131, 1], ['MOX', 96, 1], ['KIT', 74, 1]]);
  $('overlay').hidden = true;
  $('hud').hidden = $('board').hidden = $('hint').hidden = false;
  $('hint').textContent = 'space deploys the blade';
  fit();
  cw = 1280; ch = 720;
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  paint(); draw();
  const img = new Image();
  img.src = cv.toDataURL('image/png');
  img.style.cssText = 'position:fixed;left:0;top:0;width:' + cw + 'px;height:' + ch + 'px;z-index:0';
  cv.style.display = 'none';
  document.body.prepend(img);
}, 1200);
</script>
"""


def main():
    page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    if page.count("<script>") != 1:
        sys.exit("index.html no longer has exactly one <script> block - check the probe still fits")
    page = page.replace("<script>", "<script>requestAnimationFrame = () => 0;", 1)
    page = page.replace("</body>", SCENE + "</body>", 1)
    open(PROBE, "w", encoding="utf-8", newline="").write(page)
    profiles = tempfile.mkdtemp(prefix="retron-shot-")   # not under ROOT: these must never land in the repo
    try:
        if os.path.exists(OUT):
            os.remove(OUT)
        for i in range(6):
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=1280,720", "--screenshot=" + OUT,
                            "--virtual-time-budget=6000",
                            "--user-data-dir=%s" % os.path.join(profiles, str(i)),
                            "file:///" + PROBE.replace(os.sep, "/")], capture_output=True)
            if os.path.exists(OUT):
                print("wrote %s (%d bytes) on try %d" % (OUT, os.path.getsize(OUT), i + 1))
                return
            time.sleep(3)
        sys.exit("Edge wrote no screenshot in six tries")
    finally:
        os.path.exists(PROBE) and os.remove(PROBE)
        shutil.rmtree(profiles, ignore_errors=True)


main()
