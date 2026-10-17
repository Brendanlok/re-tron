"""Re-take press/shot-0-menu.png from whatever index.html currently draws.

Run it from the repo root: python press/make-menu-shot.py

The shot it replaces was taken on 30 Sep by a probe that never set isTouch, so the one picture of
the menu showed the DESKTOP copy ("arrow keys or WASD steer - space deploys the blade", "space or
click") squeezed into a phone's proportions - keys a phone does not have, on the shot most people
open from a phone. It also showed an empty floor behind the menu, three weeks after the attract
loop was added precisely because an empty floor read as dead. Same lesson as the wide shot: the
picture has to be regenerated from the page, not remembered.

How it works: index.html is copied to a scratch probe with requestAnimationFrame stubbed out, fetch
left pending (so nothing touches the live arena and the board never says it failed to load) and
isTouch forced true, then the menu's own attract loop is stepped a few hundred times for riders on
the floor and headless Edge is asked for one screenshot. Quirks handled, all measured:
  * Edge lays the page out at the window size but reports innerWidth/innerHeight smaller, so the
    canvas is sized from the window size rather than from fit().
  * Edge does not composite a canvas into --screenshot, so the probe hands it a plain <img> of the
    same pixels (cv.toDataURL) BEHIND the menu, and hides the canvas. The overlay is DOM and
    composites on its own.
  * Back-to-back Edge runs write nothing at all, roughly every other try, hence the retry loop.
  * Math.random is seeded, so the riders land in the same place every run and a re-shoot is a
    re-shoot rather than a new picture.

The board rows are made up, the same way the wide shot's in-arena top-riders list is: the live board
is pre-launch junk and will be wiped on launch morning. They obey the real scoring rule
(score = whole seconds alive + 10 per knockout) so nothing in the picture is impossible.
"""
import os, shutil, subprocess, sys, tempfile, time

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROBE = os.path.join(ROOT, "_probe_menu.html")
OUT = os.path.join(HERE, "shot-0-menu.png")
CSS_W, CSS_H, SCALE = 500, 1040, 2        # 1000x2080, the size of the file this replaces

SCENE = """
<script>
setTimeout(function () {
  let seed = 118785;   // picked by measurement: of twenty, the run that leaves the most ribbon on the floor with all four riders still up
  Math.random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let i = 0; i < 520; i++) demoStep();   // the menu's own riders, laying and losing real ribbon
  lbData = {
    today: [['ZED', 138, 88.4, 5], ['MOX', 101, 61.2, 4], ['KIT', 94, 74.9, 2], ['ORA', 75, 45.1, 3], ['VEX', 62, 52.7, 1]],
    all: [['ZED', 309, 199.3, 11], ['NYX', 241, 141.6, 10], ['MOX', 188, 128.4, 6], ['KIT', 150, 90.2, 6], ['ORA', 121, 71.8, 5]]
  };
  lbView = 'today'; paintLb();
  dpr = %(scale)d; cw = %(w)d; ch = %(h)d;
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  cv.width = cw * dpr; cv.height = ch * dpr;
  draw();
  const img = new Image();
  img.src = cv.toDataURL('image/png');
  img.style.cssText = 'position:fixed;left:0;top:0;width:' + cw + 'px;height:' + ch + 'px;z-index:0';
  cv.style.display = 'none';
  document.body.prepend(img);
}, 1200);
</script>
""" % {"scale": SCALE, "w": CSS_W, "h": CSS_H}


def main():
    page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    if page.count("<script>") != 1:
        sys.exit("index.html no longer has exactly one <script> block - check the probe still fits")
    if page.count("const isTouch =") != 1:
        sys.exit("index.html no longer declares isTouch once - check the probe still fits")
    page = page.replace("<script>", "<script>requestAnimationFrame = () => 0; fetch = () => new Promise(() => {});", 1)
    page = page.replace("const isTouch =", "const isTouch = true ||", 1)   # a phone, so the phone copy and the pad
    page = page.replace("</body>", SCENE + "</body>", 1)
    open(PROBE, "w", encoding="utf-8", newline="").write(page)
    profiles = tempfile.mkdtemp(prefix="retron-shot-")   # not under ROOT: these must never land in the repo
    try:
        if os.path.exists(OUT):
            os.remove(OUT)
        for i in range(6):
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=%d,%d" % (CSS_W, CSS_H),
                            "--force-device-scale-factor=%d" % SCALE,
                            "--screenshot=" + OUT, "--virtual-time-budget=6000",
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
