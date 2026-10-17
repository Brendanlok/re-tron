"""Repack press/re-tron.zip from this folder. Run from the repo root: python press/pack-zip.py

preflight.py tells you the zip has gone stale; nothing put it right again, so it was done by hand
every time, and it went stale twice in one day on 1 Oct. The file list is read from the zip itself,
so adding a file to the game still means adding it here deliberately - this only refreshes contents.
"""
import os, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.path.join(ROOT, "press", "re-tron.zip")

names = zipfile.ZipFile(ZIP).namelist()
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        z.write(os.path.join(ROOT, n), n)
        print("packed %s (%d bytes)" % (n, os.path.getsize(os.path.join(ROOT, n))))
