#!/usr/bin/env python3
"""Run every test suite.

    python run-tests.py

Node is needed for the four JavaScript suites; they are skipped with a notice
if it is missing, and the gateway suite runs either way.
"""

import shutil
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SUITES = [
    ("logic (coords, rules, perft)", "node", ["tests/logic.test.mjs"]),
    ("geometry (the piece set)", "node", ["tests/geometry.test.mjs"]),
    ("engine (movegen, search, levels)", "node", ["tests/engine.test.mjs"]),
    ("look (player colours)", "node", ["tests/look.test.mjs"]),
    ("gateway (server, opponents)", sys.executable, ["tests/test_gateway.py"]),
]

failed = []
for title, runner, args in SUITES:
    print(f"\n{'=' * 64}\n{title}\n{'=' * 64}")
    if runner == "node" and not shutil.which("node"):
        print("  skipped — node is not installed")
        continue
    result = subprocess.run([runner, *args], cwd=ROOT)
    if result.returncode != 0:
        failed.append(title)

print(f"\n{'=' * 64}")
if failed:
    print("FAILED: " + ", ".join(failed))
    raise SystemExit(1)
print("all suites passed")
