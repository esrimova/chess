#!/usr/bin/env python3
"""Package the game so it runs on a machine with no Python.

    python tools/build-exe.py

Needs PyInstaller, and only on the machine that builds:  pip install pyinstaller
The people who play never need it, or Python.

It writes dist/AIChess3D/, a folder that is the whole game:

    AIChess3D.exe          the gateway, with Python folded inside it
    Play AI Chess3D.bat    the same launcher as ever; it uses the exe when present
    web/                   the page, kept as plain files so they stay editable
    LICENSE, README.md

and dist/AIChess3D-<system>.zip of the same, which is what to hand to someone.
Build on the operating system you are building for: PyInstaller does not
cross-compile.

The build ends by starting the result and asking it for the page, the book and
the health check, so a broken package fails here rather than on somebody else's
desktop.
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
DIST = os.path.join(ROOT, "dist")
NAME = "AIChess3D"
OUT = os.path.join(DIST, NAME)
EXE = os.path.join(OUT, NAME + (".exe" if os.name == "nt" else ""))


def build():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("PyInstaller is not installed.  pip install pyinstaller", file=sys.stderr)
        return 1

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)

    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--console",
        "--name", NAME,
        "--distpath", os.path.join(BUILD, "bin"),
        "--workpath", os.path.join(BUILD, "work"),
        "--specpath", BUILD,
        # The gateway is standard library only; these are the big parts of it
        # that it never touches.
        "--exclude-module", "tkinter",
        os.path.join(ROOT, "server.py"),
    ], check=True, cwd=ROOT)

    built = os.path.join(BUILD, "bin", os.path.basename(EXE))
    shutil.copy2(built, EXE)
    shutil.copytree(os.path.join(ROOT, "web"), os.path.join(OUT, "web"))
    for name in ("Play AI Chess3D.bat", "LICENSE", "README.md"):
        shutil.copy2(os.path.join(ROOT, name), os.path.join(OUT, name))
    return 0


def smoke_test(port=8791):
    """Run the packaged program and reach it the way a browser and the page would."""
    env = dict(os.environ, CHESS3D_QUIET="1")
    proc = subprocess.Popen([EXE, "--port", str(port), "--no-browser"], cwd=OUT,
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen(base + "/", timeout=2).read()
                break
            except OSError:
                if time.time() > deadline or proc.poll() is not None:
                    raise SystemExit("the packaged program did not start")
                time.sleep(0.3)

        def get(path):
            return urllib.request.urlopen(base + path, timeout=5).read()

        page = get("/").decode("utf-8")
        assert "AI Chess" in page, "the page did not load"
        assert b"createMaterials" in get("/js/themes.js"), "modules were not served"
        assert json.loads(get("/openings.json"))["positions"], "the opening book is missing"
        assert b"chooseMove" in get("/js/search.worker.js"), "the search worker is missing"

        request = urllib.request.Request(
            base + "/health", data=b'{"config": {}}',
            headers={"Content-Type": "application/json", "X-Chess3D": "1"})
        assert json.loads(urllib.request.urlopen(request, timeout=5).read()), "health failed"
        print("smoke test passed")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def package():
    system = {"nt": "windows", "posix": sys.platform}.get(os.name, sys.platform)
    archive = shutil.make_archive(os.path.join(DIST, f"{NAME}-{system}"), "zip", DIST, NAME)
    print(f"wrote {os.path.relpath(archive, ROOT)}")


if __name__ == "__main__":
    code = build()
    if code:
        raise SystemExit(code)
    smoke_test()
    package()
