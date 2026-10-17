"""Re-make the four home-screen icons from the page's own bike.

Run it from the repo root: python press/make-icons.py

The icons were drawn on 21 Sep at 04:22 by a one-off script that was never kept, and the bike was
redesigned into a dart at 23:48 the SAME DAY - so every icon shows a blunt pill with a white block
at the front, a machine the game stopped drawing nineteen hours later. Exactly the rot found in
og.png on 17 Oct, in the asset a phone player keeps on their home screen. It exists now so the
icons are regenerated from the page rather than remembered.

The bike is drawn by the page's own cycle(), so a look change can never leave the icons behind
again. The ribbon elbow is two strokes with the page's own ribbon constants (0.34 of a cell wide,
a white core at 0.1, alphas 0.5 and 0.42) - the arena's draw() is not used, because at icon size
the floor grid and the red arena edge are noise rather than composition.

favicon.svg is hand-drawn and NOT written by this script: it is the same picture redrawn flat for
a 16px tab. If the bike changes again, that file changes by hand too.

Edge quirks handled here, measured and shared with make-og.py and make-wide-shot.py:
  * Edge lays out at the window size but reports innerWidth/innerHeight smaller, so cw/ch are set.
  * Edge will not composite a canvas into --screenshot, so the probe hands it an <img> instead.
  * Roughly every other back-to-back run writes no file at all, hence the retry loop.
"""
import os, shutil, subprocess, sys, tempfile, time
from PIL import Image

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SIZE = 512

# The 21 Sep composition kept as it was - a ribbon climbing out of the bottom left, turning right,
# running into the back of the bike - with the real machine on the end of it. Coordinates are from
# the middle of the square so the whole picture can shrink for the maskable pair, which must keep
# clear of the circle an Android launcher crops it to.
SCENE = """
<script>
setTimeout(function () {
  const S = %d, K = %s, C = S / 2, cell = 112 * K;
  dpr = 1; cw = ch = S;
  cv.style.width = cv.style.height = S + 'px'; cv.width = cv.height = S;
  $('overlay').hidden = true;
  const P = (x, y) => [C + x * K, C + y * K];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, S, S);
  const glow = ctx.createRadialGradient(C, C, 0, C, C, S * 0.62);   // the arena's light, not a flat tile
  glow.addColorStop(0, 'rgba(32,58,86,.55)'); glow.addColorStop(1, 'rgba(10,14,20,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, S, S);

  const elbow = () => {
    ctx.beginPath();
    ctx.moveTo.apply(ctx, P(-160, 84)); ctx.lineTo.apply(ctx, P(-160, -74)); ctx.lineTo.apply(ctx, P(-29, -74));
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  elbow();
  ctx.strokeStyle = rgb(MINE, 0.5); ctx.shadowColor = rgb(MINE, 0.85); ctx.shadowBlur = cell * 0.8;
  ctx.lineWidth = cell * 0.34; ctx.stroke(); ctx.shadowBlur = 0;
  elbow();
  ctx.strokeStyle = rgb([255, 255, 255], 0.42); ctx.lineWidth = Math.max(1, cell * 0.1); ctx.stroke();

  const b = P(64, -74);
  cycle(b[0], b[1], 0, MINE, cell, true, true);

  const img = new Image();
  img.src = cv.toDataURL('image/png');
  img.style.cssText = 'position:fixed;left:0;top:0;width:' + S + 'px;height:' + S + 'px;z-index:9';
  cv.style.display = 'none';
  document.body.prepend(img);
}, 900);
</script>
"""


def shoot(k, out):
    # one probe file per scale: a shared path let a lingering Edge from the previous run
    # screenshot the wrong scale, and the two icons came out identical.
    probe = os.path.join(ROOT, "_probe_icon_%s.html" % str(k).replace(".", ""))
    page = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    if page.count("<script>") != 1:
        sys.exit("index.html no longer has exactly one <script> block - check the probe still fits")
    page = page.replace("<script>", "<script>requestAnimationFrame = () => 0; fetch = () => new Promise(() => 0);", 1)
    page = page.replace("</body>", (SCENE % (SIZE, k)) + "</body>", 1)
    open(probe, "w", encoding="utf-8", newline="").write(page)
    profiles = tempfile.mkdtemp(prefix="retron-icon-")   # not under ROOT: these must never land in the repo
    try:
        if os.path.exists(out):
            os.remove(out)
        for i in range(6):
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=%d,%d" % (SIZE, SIZE), "--screenshot=" + out,
                            "--virtual-time-budget=6000",
                            "--user-data-dir=%s" % os.path.join(profiles, str(i)),
                            "file:///" + probe.replace(os.sep, "/")], capture_output=True)
            if os.path.exists(out):
                print("wrote %s (%d bytes) on try %d" % (os.path.basename(out), os.path.getsize(out), i + 1))
                return
            time.sleep(3)
        sys.exit("Edge wrote no screenshot in six tries")
    finally:
        os.path.exists(probe) and os.remove(probe)
        shutil.rmtree(profiles, ignore_errors=True)


# 0.78 is the maskable pair: an Android launcher may crop to the circle inscribed in the middle 80%,
# so the picture is shrunk to sit inside it rather than having its nose and its tail clipped off.
for scale, big in ((1, "icon-512.png"), (0.78, "icon-maskable-512.png")):
    out = os.path.join(ROOT, big)
    shoot(scale, out)
    small = out.replace("512", "192")
    Image.open(out).resize((192, 192), Image.LANCZOS).save(small)
    print("wrote %s (%d bytes)" % (os.path.basename(small), os.path.getsize(small)))
