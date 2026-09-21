#!/usr/bin/env python3
"""Backend tests for the gateway.

Nothing here is mocked. `server.py` is started as a real process and reached
over real HTTP on a real socket, exactly as the browser reaches it.

The OpenAI-compatible endpoint the `http` opponent talks to is also a real
HTTP server speaking the real protocol — it stands in for LM Studio, which is
not always running, and it is a genuine second service rather than a stub of
the thing being tested. Where a real local model *is* listening on :1234, the
last test uses it.

    python tests/test_gateway.py
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server as gateway  # noqa: E402  (imported for its pure functions)

PASSED = 0
FAILED = 0
FAILURES = []


def test(name):
    def wrap(fn):
        global PASSED, FAILED
        try:
            fn()
            PASSED += 1
            print(f"  ok    {name}")
        except Exception as exc:  # noqa: BLE001 - this is the test reporter
            FAILED += 1
            FAILURES.append((name, exc))
            print(f"  FAIL  {name}")
            print(f"        {exc}")
        return fn
    return wrap


def section(title):
    print(f"\n{title}")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, response.read(), dict(response.headers)


def post(url, payload, timeout=30):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


# ------------------------------------------------- a real model-shaped server

class FakeModelHandler(BaseHTTPRequestHandler):
    """Speaks the OpenAI chat-completions protocol for real, over real HTTP."""

    replies = []          # consumed in order; the last one repeats
    seen = []
    model_name = "test-model-1"

    def log_message(self, *args):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/v1/models"):
            self._json({"data": [{"id": type(self).model_name}]})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).seen.append(body)

        replies = type(self).replies
        index = min(len(type(self).seen) - 1, len(replies) - 1)
        content = replies[index] if replies else "e4"
        self._json({"choices": [{"message": {"role": "assistant", "content": content}}]})


def start_model_server(replies, model_name="test-model-1"):
    FakeModelHandler.replies = list(replies)
    FakeModelHandler.seen = []
    FakeModelHandler.model_name = model_name
    port = free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), FakeModelHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{port}"


# ----------------------------------------------------------- move list fixture

OPENING_MOVES = [
    {"uci": "e2e4", "san": "e4", "captured": None, "promotion": None, "check": False},
    {"uci": "d2d4", "san": "d4", "captured": None, "promotion": None, "check": False},
    {"uci": "g1f3", "san": "Nf3", "captured": None, "promotion": None, "check": False},
    {"uci": "b1c3", "san": "Nc3", "captured": None, "promotion": None, "check": False},
]
OPENING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
LEGAL_UCI = {m["uci"] for m in OPENING_MOVES}


def main():
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "server.py"), "--port", str(port),
         "--host", "127.0.0.1", "--no-browser"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        env={**os.environ, "CHESS3D_QUIET": "1"},
    )
    base = f"http://127.0.0.1:{port}"

    try:
        if not wait_for(port):
            out, err = proc.communicate(timeout=5)
            raise SystemExit(f"the gateway never started\nstdout:{out}\nstderr:{err}")

        run_tests(base)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(f"\n{PASSED} passed, {FAILED} failed")
    if FAILED:
        for name, exc in FAILURES:
            print(f"\n--- {name}\n{exc!r}")
        return 1
    return 0


def run_tests(base):
    # ------------------------------------------------------------- serving
    section("gateway — serving the application")

    @test("the page is served")
    def _():
        status, body, headers = get(base + "/")
        assert status == 200, status
        text = body.decode("utf-8")
        assert "<canvas id=\"view\">" in text, "the canvas is missing from the page"
        assert "js/main.js" in text, "the entry point is not referenced"

    @test("every module the page imports is reachable")
    def _():
        for path in [
            "/js/main.js", "/js/game.js", "/js/coords.js", "/js/pieces.js",
            "/js/board.js", "/js/scene.js", "/js/camera.js", "/js/animate.js",
            "/js/picker.js", "/js/engines.js", "/js/hud.js", "/js/themes.js",
            "/js/vendor/three.module.js", "/js/vendor/chess.js",
            "/js/vendor/RoomEnvironment.js", "/js/vendor/BufferGeometryUtils.js",
            "/css/style.css", "/themes.json",
        ]:
            status, body, _headers = get(base + path)
            assert status == 200, f"{path} -> {status}"
            assert len(body) > 0, f"{path} is empty"

    @test("no vendored module asks for a bare 'three' the browser cannot resolve")
    def _():
        for path in ["/js/vendor/RoomEnvironment.js", "/js/vendor/BufferGeometryUtils.js"]:
            _status, body, _headers = get(base + path)
            text = body.decode("utf-8")
            assert "from 'three'" not in text, f"{path} still imports bare 'three'"

    @test("themes.json parses and declares complete themes")
    def _():
        _status, body, _headers = get(base + "/themes.json")
        data = json.loads(body)
        assert len(data["themes"]) >= 3, "fewer than three themes"
        for theme in data["themes"]:
            for key in ("id", "name", "background", "board", "pieces", "highlight", "lighting"):
                assert key in theme, f"theme {theme.get('id')} has no {key}"
            # A theme must restyle all three together, or it is a recolour.
            assert "top" in theme["background"] and "bottom" in theme["background"]
            for side in ("light", "dark", "frame"):
                assert side in theme["board"], f"{theme['id']} board has no {side}"
            for colour in ("w", "b"):
                assert colour in theme["pieces"], f"{theme['id']} pieces has no {colour}"
        ids = [t["id"] for t in data["themes"]]
        assert len(ids) == len(set(ids)), "duplicate theme ids"
        assert data["default"] in ids, "default theme is not in the list"

    # -------------------------------------------------------------- health
    section("gateway — /health")

    @test("health reports memory, with how much it remembers")
    def _():
        status, data = post(base + "/health", {"config": {}})
        assert status == 200, status
        assert data["memory"]["ok"] is True, data
        assert data["memory"]["positions"] > 100, data
        assert "http" in data and "relay" in data

    @test("health reports an unreachable endpoint honestly, without failing")
    def _():
        dead = f"http://127.0.0.1:{free_port()}"
        status, data = post(base + "/health", {"config": {"http": {"url": dead}}})
        assert status == 200, status
        assert data["http"]["ok"] is False
        assert data["http"]["error"], "an unreachable endpoint reported no reason"

    @test("health finds a real endpoint and names the loaded model")
    def _():
        httpd, url = start_model_server(["e4"], model_name="qwen-test-7b")
        try:
            _status, data = post(base + "/health", {"config": {"http": {"url": url}}})
            assert data["http"]["ok"] is True, data["http"]
            assert data["http"]["model"] == "qwen-test-7b", data["http"]
        finally:
            httpd.shutdown()

    @test("health reports the relay and the addresses to reach it on")
    def _():
        _status, data = post(base + "/health", {"config": {}})
        assert "relay" in data, data
        assert "connected" in data["relay"], data
        assert isinstance(data.get("addresses"), list), data

    # ------------------------------------------------------------- builtin
    section("gateway — pre-installed memory")

    @test("it returns a move from the list it was given, at every difficulty")
    def _():
        for difficulty in ("easy", "medium", "hard"):
            for _ in range(15):
                status, data = post(base + "/move", {
                    "kind": "memory", "fen": OPENING_FEN,
                    "legal": OPENING_MOVES, "difficulty": difficulty,
                })
                assert status == 200, (difficulty, status, data)
                assert data["move"] in LEGAL_UCI, (difficulty, data)

    @test("the old name for it still works, so a saved setting is not broken")
    def _():
        for kind in ("builtin", "random"):
            status, data = post(base + "/move", {
                "kind": kind, "fen": OPENING_FEN, "legal": OPENING_MOVES,
            })
            assert status == 200, (kind, data)
            assert data["move"] in LEGAL_UCI, (kind, data)

    @test("it plays from the book, and says so")
    def _():
        # A real opening position: memory should recognise it, not guess.
        status, data = post(base + "/move", {
            "kind": "memory", "fen": OPENING_FEN, "legal": OPENING_MOVES,
        })
        assert status == 200, data
        assert data["detail"]["source"] == "book", data
        assert data["move"] in {"e2e4", "d2d4", "c2c4", "g1f3"}, data

    @test("deep in a line it names the opening it is following")
    def _():
        najdorf = "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6"
        moves = [
            {"uci": "c1e3", "san": "Be3", "captured": None, "promotion": None, "check": False},
            {"uci": "f1e2", "san": "Be2", "captured": None, "promotion": None, "check": False},
        ]
        status, data = post(base + "/move", {"kind": "memory", "fen": najdorf, "legal": moves})
        assert status == 200, data
        assert data["detail"].get("opening") == "Sicilian, Najdorf", data

    @test("the opening move is not given a name, because it identifies nothing")
    def _():
        # Every line in the book starts from here, so naming one would be a lie.
        status, data = post(base + "/move", {
            "kind": "memory", "fen": OPENING_FEN, "legal": OPENING_MOVES,
        })
        assert not data["detail"].get("opening"), data

    @test("a position is recognised however it was transposed into")
    def _():
        # Same position, absurd move counters: the book key ignores them.
        odd = OPENING_FEN.replace(" 0 1", " 7 99")
        status, data = post(base + "/move", {
            "kind": "memory", "fen": odd, "legal": OPENING_MOVES,
        })
        assert data["detail"]["source"] == "book", data

    @test("out of book it falls back and says that too")
    def _():
        unknown = "8/5k2/8/8/8/8/5K2/R7 w - - 0 1"
        moves = [
            {"uci": "a1a2", "san": "Ra2", "captured": None, "promotion": None, "check": False},
            {"uci": "a1b1", "san": "Rb1", "captured": None, "promotion": None, "check": False},
        ]
        status, data = post(base + "/move", {"kind": "memory", "fen": unknown, "legal": moves})
        assert status == 200, data
        assert data["detail"]["source"] != "book", data
        assert "out of book" in data["detail"]["note"], data

    @test("out of book, on hard, it prefers the capture it was shown")
    def _():
        unknown = "8/5k2/8/8/3q4/8/5K2/3Q4 w - - 0 1"
        moves = [
            {"uci": "f2f1", "san": "Kf1", "captured": None, "promotion": None, "check": False},
            {"uci": "f2f3", "san": "Kf3", "captured": None, "promotion": None, "check": False},
            {"uci": "d1d4", "san": "Qxd4", "captured": "q", "promotion": None, "check": False},
        ]
        for _ in range(12):
            _status, data = post(base + "/move", {
                "kind": "memory", "fen": unknown, "legal": moves, "difficulty": "hard",
            })
            assert data["move"] == "d1d4", data

    @test("plain strings work as a move list as well as objects")
    def _():
        status, data = post(base + "/move", {
            "kind": "memory", "fen": OPENING_FEN, "legal": ["e2e4", "d2d4"],
        })
        assert status == 200, data
        assert data["move"] in {"e2e4", "d2d4"}, data

    @test("a position with no legal moves is refused, not guessed at")
    def _():
        status, data = post(base + "/move", {"kind": "memory", "fen": OPENING_FEN, "legal": []})
        assert status == 400, status
        assert "error" in data

    @test("an unknown opponent kind is refused")
    def _():
        status, data = post(base + "/move", {
            "kind": "telepathy", "fen": OPENING_FEN, "legal": OPENING_MOVES,
        })
        assert status == 400, status
        assert "error" in data

    @test("a malformed request does not take the gateway down")
    def _():
        request = urllib.request.Request(
            base + "/move", data=b"{not json",
            headers={"Content-Type": "application/json"},
        )
        try:
            urllib.request.urlopen(request, timeout=10)
            raise AssertionError("malformed JSON was accepted")
        except urllib.error.HTTPError as exc:
            assert exc.code == 400, exc.code
        # and it is still serving
        status, _data = post(base + "/health", {"config": {}})
        assert status == 200

    # ------------------------------------------------------------ endpoint
    section("gateway — an OpenAI-compatible endpoint")

    @test("a clean SAN answer is accepted")
    def _():
        httpd, url = start_model_server(["e4"])
        try:
            status, data = post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": url},
            })
            assert status == 200, data
            assert data["move"] == "e2e4", data
            assert data["detail"]["accepted_on"] == 1, data
        finally:
            httpd.shutdown()

    @test("the request that goes out is a real chat completion")
    def _():
        httpd, url = start_model_server(["Nf3"])
        try:
            post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": url, "model": "my-model"},
            })
            sent = FakeModelHandler.seen[-1]
            assert sent["model"] == "my-model", sent
            assert sent["messages"][0]["role"] == "system"
            assert OPENING_FEN in sent["messages"][1]["content"], "the position was not sent"
            assert "Nf3" in sent["messages"][1]["content"], "the legal moves were not sent"
        finally:
            httpd.shutdown()

    @test("a blank model is resolved from the endpoint rather than left empty")
    def _():
        # Some servers refuse a request with no model instead of picking one,
        # so a blank box asks the endpoint what it has and names the answer.
        httpd, url = start_model_server(["d4"], model_name="loaded-model-x")
        try:
            status, data = post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": url, "model": ""},
            })
            assert status == 200, data
            assert data.get("move") == "d2d4", data
            assert FakeModelHandler.seen[-1].get("model") == "loaded-model-x", FakeModelHandler.seen[-1]
        finally:
            httpd.shutdown()

    @test("an embedding model is never chosen as the chat model")
    def _():
        import server as gw
        httpd, url = start_model_server(["e4"], model_name="ignored")
        try:
            # The real endpoint lists an embedding model alongside a chat one;
            # picking the wrong one produces a baffling failure at move time.
            ids = gw.list_models(url, "")
            assert ids, "no models listed"
            assert all("embed" not in i.lower() for i in ids), ids
        finally:
            httpd.shutdown()

    @test("an endpoint that refuses is quoted, not reported as unreachable")
    def _():
        class RefusingHandler(FakeModelHandler):
            def do_POST(self):
                self._json({"error": {"message": "No models loaded.",
                                      "type": "invalid_request_error"}}, 400)

        port = free_port()
        httpd = ThreadingHTTPServer(("127.0.0.1", port), RefusingHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            status, data = post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": f"http://127.0.0.1:{port}"},
            })
            assert status == 200, status
            assert "error" in data, data
            assert "refused" in data["error"].lower(), data
            assert "No models loaded" in str(data["detail"]), data
            assert "reach" not in data["error"].lower(), (
                "a refusal was reported as unreachability: " + data["error"])
        finally:
            httpd.shutdown()

    @test("answers wrapped in fences, JSON or chatter are still read")
    def _():
        cases = [
            ("```\ne4\n```", "e2e4"),
            ('```json\n{"move": "Nf3"}\n```', "g1f3"),
            ('{"move":"d4","reason":"central"}', "d2d4"),
            ("I think the strongest continuation here is Nc3.", "b1c3"),
            ("Let me consider d4... actually no. My move: e4", "e2e4"),
            ("  e2e4  ", "e2e4"),
        ]
        for reply, expected in cases:
            httpd, url = start_model_server([reply])
            try:
                _status, data = post(base + "/move", {
                    "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                    "config": {"url": url},
                })
                assert data.get("move") == expected, f"{reply!r} -> {data}"
            finally:
                httpd.shutdown()

    @test("an illegal move is sent back with the reason, and the retry is accepted")
    def _():
        httpd, url = start_model_server(["Qxh7", "e4"])
        try:
            _status, data = post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": url},
            })
            assert data.get("move") == "e2e4", data
            assert data["detail"]["accepted_on"] == 2, data
            # The second request must carry the correction.
            second = FakeModelHandler.seen[1]
            assert len(second["messages"]) == 4, second["messages"]
            assert "not one of the legal moves" in second["messages"][-1]["content"]
        finally:
            httpd.shutdown()

    @test("three illegal moves fails honestly, and never substitutes a move")
    def _():
        httpd, url = start_model_server(["Qxh7", "Ke2", "castle kingside"])
        try:
            status, data = post(base + "/move", {
                "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"url": url},
            })
            assert status == 200, status
            assert "move" not in data or not data.get("move"), f"a move was invented: {data}"
            assert "error" in data, data
            assert "legal move" in data["error"], data
            assert len(data["detail"]["attempts"]) == 3, data["detail"]
            assert len(FakeModelHandler.seen) == 3, "it did not try three times"
        finally:
            httpd.shutdown()

    @test("an unreachable endpoint is reported, not retried forever")
    def _():
        dead = f"http://127.0.0.1:{free_port()}"
        started = time.time()
        status, data = post(base + "/move", {
            "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"url": dead},
        })
        assert status == 200, status
        assert "error" in data, data
        assert "reach" in data["error"].lower(), data
        assert time.time() - started < 20, "it took too long to give up"

    # --------------------------------------------------------------- relay
    section("gateway — an AI connected over the relay")

    def ask_for_turn(wait=5, timeout=30):
        with urllib.request.urlopen(base + "/relay/turn?wait=%d" % wait, timeout=timeout) as r:
            return json.loads(r.read())

    def play_as_ai(moves_to_send, turns=1, patience=25):
        """A real relay client in a thread, doing exactly what the published
        instructions tell an AI to do: ask for the turn, then post a move."""
        seen = []

        def run():
            for i in range(turns):
                deadline = time.time() + patience
                turn = None
                while time.time() < deadline:
                    try:
                        candidate = ask_for_turn()
                    except Exception as exc:  # noqa: BLE001
                        seen.append({"error": repr(exc)})
                        return
                    if candidate.get("your_turn"):
                        turn = candidate
                        break
                if not turn:
                    seen.append({"error": "never got a turn"})
                    return
                seen.append(turn)
                move = moves_to_send[min(i, len(moves_to_send) - 1)]
                _status, reply = post(base + "/relay/move", {"id": turn["id"], "move": move})
                seen.append(reply)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, seen

    @test("the instructions are served, and say what to do")
    def _():
        status, body, _headers = get(base + "/relay")
        assert status == 200, status
        text = body.decode("utf-8")
        assert "/relay/turn" in text and "/relay/move" in text, text[:200]
        assert "legal" in text and "id" in text
        # Transport-agnostic: nothing that assumes a terminal or an install.
        for word in ("terminal", "shell", "stdin", "npm", "pip install"):
            assert word not in text.lower(), "instructions mention " + word

    @test("a connected client is handed the turn and its move is played")
    def _():
        post(base + "/relay/cancel", {})
        thread, seen = play_as_ai(["Nf3"])
        status, data = post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 30},
        }, timeout=60)
        thread.join(timeout=15)
        assert status == 200, data
        assert data.get("move") == "g1f3", data
        assert data["detail"]["source"] == "relay", data
        turn = seen[0]
        assert turn["fen"] == OPENING_FEN, turn
        assert "Nf3" in turn["legal"], turn
        assert turn["color"] == "white", turn

    @test("the turn call waits for the board instead of answering immediately")
    def _():
        post(base + "/relay/cancel", {})
        started = time.time()
        data = ask_for_turn(wait=2, timeout=20)
        waited = time.time() - started
        assert data["your_turn"] is False, data
        assert waited >= 1.5, "returned after %.2fs instead of waiting" % waited

    @test("UCI is accepted as well as SAN")
    def _():
        post(base + "/relay/cancel", {})
        thread, _seen = play_as_ai(["d2d4"])
        _status, data = post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 30},
        }, timeout=60)
        thread.join(timeout=15)
        assert data.get("move") == "d2d4", data

    @test("an illegal move is refused with the reason, and the turn stays open")
    def _():
        post(base + "/relay/cancel", {})
        results = []

        def run():
            deadline = time.time() + 25
            turn = None
            while time.time() < deadline and not turn:
                candidate = ask_for_turn()
                if candidate.get("your_turn"):
                    turn = candidate
            if not turn:
                results.append({"ok": False, "error": "never got a turn"})
                return
            _s, bad = post(base + "/relay/move", {"id": turn["id"], "move": "Qxh8"})
            results.append(bad)
            _s, good = post(base + "/relay/move", {"id": turn["id"], "move": "e4"})
            results.append(good)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        _status, data = post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 30},
        }, timeout=60)
        thread.join(timeout=15)
        assert results[0]["ok"] is False, results[0]
        assert "not a legal move" in results[0]["error"], results[0]
        assert "e4" in results[0]["error"], "the refusal should list what is legal"
        assert results[1]["ok"] is True, results[1]
        assert data.get("move") == "e2e4", data

    @test("a move sent when nothing is waiting is refused")
    def _():
        post(base + "/relay/cancel", {})
        _status, data = post(base + "/relay/move", {"id": 999, "move": "e4"})
        assert data["ok"] is False, data
        assert "not your turn" in data["error"].lower(), data

    @test("a stale turn id is refused, so an old answer cannot land late")
    def _():
        post(base + "/relay/cancel", {})
        thread, _seen = play_as_ai(["e4"])
        post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 30},
        }, timeout=60)
        thread.join(timeout=15)
        _status, data = post(base + "/relay/move", {"id": 1, "move": "e4"})
        assert data["ok"] is False, data

    @test("with nothing connected the board gives up and says so")
    def _():
        post(base + "/relay/cancel", {})
        started = time.time()
        status, data = post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 2},
        }, timeout=30)
        assert status == 200, status
        assert not data.get("move"), "a move was invented: %r" % (data,)
        # Either wording is correct and they mean different things: nothing has
        # ever connected, or something connected recently and did not answer.
        assert data["error"] in ("No AI has connected yet.", "No AI answered."), data
        assert "instructions" in data["detail"], data
        assert time.time() - started < 20, "it did not give up on time"

    @test("cancelling releases a board that is waiting")
    def _():
        post(base + "/relay/cancel", {})
        result = {}

        def ask():
            _s, d = post(base + "/move", {
                "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"timeout": 60},
            }, timeout=90)
            result["data"] = d

        thread = threading.Thread(target=ask, daemon=True)
        thread.start()
        time.sleep(1.5)
        post(base + "/relay/cancel", {})
        thread.join(timeout=25)
        assert result, "the waiting request never returned"
        assert "error" in result["data"], result["data"]

    @test("status shows a client once it has asked for a turn")
    def _():
        post(base + "/relay/cancel", {})
        thread, _seen = play_as_ai(["e4"])
        time.sleep(1.2)
        _s, body, _h = get(base + "/relay/status")
        status = json.loads(body)
        assert status["connected"] is True, status
        post(base + "/move", {
            "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"timeout": 30},
        }, timeout=60)
        thread.join(timeout=15)

    @test("a whole sequence of turns runs over one connection")
    def _():
        post(base + "/relay/cancel", {})
        thread, seen = play_as_ai(["e4", "Nf3", "d4"], turns=3)
        played = []
        for _ in range(3):
            _s, data = post(base + "/move", {
                "kind": "relay", "fen": OPENING_FEN, "legal": OPENING_MOVES,
                "config": {"timeout": 30},
            }, timeout=60)
            played.append(data.get("move"))
        thread.join(timeout=20)
        assert played == ["e2e4", "g1f3", "d2d4"], played

    # ------------------------------------------------------- reply parsing
    section("gateway — reading a move out of a reply")

    @test("the last move mentioned wins, because models conclude at the end")
    def _():
        moves = gateway.normalise_moves(OPENING_MOVES)
        text = "d4 is playable, Nf3 is solid, but I will play e4"
        assert gateway.match_move(text, moves) == "e2e4"

    @test("check and mate marks do not prevent a match")
    def _():
        moves = gateway.normalise_moves([
            {"uci": "d1h5", "san": "Qh5+", "captured": None, "promotion": None, "check": True},
        ])
        assert gateway.match_move("Qh5+", moves) == "d1h5"
        assert gateway.match_move("Qh5", moves) == "d1h5"

    @test("an empty or unrelated reply matches nothing")
    def _():
        moves = gateway.normalise_moves(OPENING_MOVES)
        for text in ["", None, "I would rather not.", "42", "Qxz9"]:
            assert gateway.match_move(text, moves) is None, text

    @test("a move that is not in the list is never returned")
    def _():
        moves = gateway.normalise_moves(OPENING_MOVES)
        assert gateway.match_move("h2h4", moves) is None
        assert gateway.match_move('{"move": "O-O"}', moves) is None

    # -------------------------------------------------- a real local model
    section("gateway — against a real local model, if one is listening")

    @test("a model on :1234 plays a legal move (skipped when nothing is there)")
    def _():
        probe = {"config": {"http": {"url": "http://127.0.0.1:1234"}}}
        _status, health = post(base + "/health", probe)
        if not health["http"]["ok"]:
            print("        skipped — nothing listening on 127.0.0.1:1234")
            return
        print(f"        found {health['http'].get('model')}")
        status, data = post(base + "/move", {
            "kind": "http", "fen": OPENING_FEN, "legal": OPENING_MOVES,
            "config": {"url": "http://127.0.0.1:1234", "timeout": 120},
        }, timeout=180)
        assert status == 200, status
        assert data.get("move") in LEGAL_UCI, data


if __name__ == "__main__":
    raise SystemExit(main())
