"""Re-make og.png, the 1200x630 card every shared link, post and chat preview shows.

Run it from the repo root: python press/make-og.py

The card was drawn on 21 Sep by a one-off script that was never kept, and the bike was redesigned
into a dart nineteen hours later - so for three and a half weeks the one picture of this game that
travels on its own showed a machine the game had stopped drawing. Same rot as the two press shots,
and worse, because this one is what a post looks like before anybody clicks. It exists now so the
card is regenerated from the page rather than remembered.

Everything in the picture below the text - floor, grid, arena edge, ribbons, bikes, glow - is drawn
by the page's own draw(), on the real 40x60 board at the real riding camera, so a look change can
never leave the card behind again. Only the words are laid on top, in the menu's own colours.

Edge quirks handled here, measured and shared with make-wide-shot.py:
  * Edge lays out at the window size but reports innerWidth/innerHeight smaller, so cw/ch are set.
  * Edge will not composite a canvas into --screenshot, so the probe hands it an <img> instead.
  * Roughly every other back-to-back run writes no file at all, hence the retry loop.
"""
import os, shutil, subprocess, sys, tempfile, time

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROBE = os.path.join(ROOT, "_probe_og.html")
OUT = os.path.join(ROOT, "og.png")

# The arena behind the words, laid out so the left half stays quiet enough to read over:
# you climbing out of a corner with the blade lit, VOLT's older wall fading down the right edge,
# FLUX's nearly gone along the bottom, and one rider with NOTHING behind him - which is the twist
# the card is selling, and which the 21 Sep card never showed.
SCENE = """
<script>
setTimeout(function () {
  const at = (x, y) => y * W + x;
  let born = 0;
  function trail(id, x, y, legs) {
    for (const [dx, dy, n] of legs) for (let i = 0; i < n; i++) { walls.set(at(x, y), {o: id, born: born++}); x += dx; y += dy; }
    return [x, y];
  }
  function bike(id, nm, x, y, d, blade, charge) {
    bikes.set(id, {id, x, y, px: x, py: y, ox: x, oy: y, d, blade, charge});
    names.set(id, {n: nm, bot: id !== 1 ? 1 : 0});
  }
  tick = 2400; tickAt = performance.now();
  ws = {};                                                  // rivals' names only draw for a real arena

  born = tick - 54;                                         // fresh: your ribbon does not fade
  let p = trail(1, 17, 30, [[0, -1, 5], [1, 0, 9], [0, -1, 4]]);
  bike(1, 'YOU', p[0], p[1], 'U', true, 74);
  born = tick - 70;                                         // older: the far end is already going
  p = trail(1004, 37, 24, [[0, -1, 11], [-1, 0, 4]]);
  bike(1004, 'VOLT', p[0], p[1], 'L', true, 38);
  born = tick - 66;                                         // going: eight seconds and a wall is nothing
  p = trail(1005, 24, 27, [[1, 0, 8]]);
  bike(1005, 'FLUX', p[0], p[1], 'R', true, 61);
  bike(1007, 'NIX', 21, 15, 'R', false, 100);               // blade off: nothing behind him at all

  me = 1; riding = true;
  $('overlay').hidden = true;
  dpr = 1; cw = 1200; ch = 630;
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  cv.width = cw; cv.height = ch;
  draw();

  // The words, in the menu's own palette: the badge blue, the title white with its blue glow, the
  // body grey, the promise amber. A scrim only on the left, so the arena still shows through it.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 720, 0);
  g.addColorStop(0, 'rgba(9,12,18,.88)'); g.addColorStop(.55, 'rgba(9,12,18,.62)'); g.addColorStop(1, 'rgba(9,12,18,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 720, ch);
  const F = w => w + ' px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '.28em'; ctx.font = '700 20px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.fillStyle = '#5f86b8'; ctx.fillText('LIGHT CYCLES, ONLINE', 64, 198);
  ctx.letterSpacing = '.02em'; ctx.font = '800 100px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.shadowColor = 'rgba(95,176,255,.5)'; ctx.shadowBlur = 40;
  ctx.fillStyle = '#eaf2ff'; ctx.fillText('RE-TRON', 64, 314); ctx.shadowBlur = 0;
  ctx.letterSpacing = '0px'; ctx.font = '400 31px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.fillStyle = '#9fadc1';
  ctx.fillText('Your bike leaves nothing behind', 64, 392);
  ctx.fillText('until you switch on the blade.', 64, 432);
  ctx.font = '700 26px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ctx.fillStyle = '#ffd25f'; ctx.fillText('One shared arena. Join any time.', 64, 506);

  const img = new Image();
  img.src = cv.toDataURL('image/png');
  img.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:630px;z-index:0';
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
    profiles = tempfile.mkdtemp(prefix="retron-og-")   # not under ROOT: these must never land in the repo
    try:
        if os.path.exists(OUT):
            os.remove(OUT)
        for i in range(6):
            subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                            "--window-size=1200,630", "--screenshot=" + OUT,
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
