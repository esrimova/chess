#!/usr/bin/env python3
"""Chess3D gateway.

Serves the page and answers on behalf of whichever opponent is configured.
Standard library only: clone the repository and run it, nothing to install.

    python server.py                 # http://127.0.0.1:8770
    python server.py --port 9000
    python server.py --host 127.0.0.1    # refuse connections from the network

It serves the page *and* makes the model calls, so the two share an origin.
That is the whole reason there is a server here at all: a page opened from the
filesystem cannot reach a local model without tripping over CORS, and a page
on someone else's HTTPS host cannot reach http://127.0.0.1 at all.

This file knows no chess rules, deliberately. The board sends the legal moves
with every request and validates whatever comes back. A confused opponent can
fail to answer; it can never corrupt a game.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import socket
import subprocess
import sys
import threading
import webbrowser
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.join(ROOT, "web")

DEFAULT_LLM_URL = os.getenv("LLM_URL", "http://127.0.0.1:1234")
DEFAULT_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "90"))
DEFAULT_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.2"))
MAX_ATTEMPTS = 3

PIECE_VALUE = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}


# --------------------------------------------------------------- move lists

def normalise_moves(legal):
    """Accept either plain strings or the verbose objects the board sends."""
    out = []
    for item in legal or []:
        if isinstance(item, str):
            out.append({"uci": item, "san": item, "captured": None,
                        "promotion": None, "check": False})
        elif isinstance(item, dict):
            uci = item.get("uci") or ""
            out.append({
                "uci": uci,
                "san": item.get("san") or uci,
                "captured": item.get("captured"),
                "promotion": item.get("promotion"),
                "check": bool(item.get("check")),
            })
    return out


def match_move(text, moves):
    """Find a move from `moves` inside a model's reply.

    Small models wrap answers in fences, add a sentence of preamble, or think
    out loud first. Rather than demanding clean output, look for something
    that is unambiguously one of the moves actually available.
    """
    if not text:
        return None

    cleaned = text.strip()
    fenced = re.search(r"```(?:\w+)?\s*(.+?)\s*```", cleaned, re.S)
    if fenced:
        cleaned = fenced.group(1).strip()

    # A JSON object with a move field is the happy path.
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(cleaned[start:end + 1])
            for key in ("move", "san", "uci", "best_move", "bestmove"):
                value = obj.get(key)
                if isinstance(value, str):
                    hit = _exact(value, moves)
                    if hit:
                        return hit
        except (json.JSONDecodeError, AttributeError):
            pass

    # Otherwise scan the text for any legal move, preferring the last one
    # mentioned: a model that reasons aloud states its conclusion at the end.
    by_uci = {m["uci"].lower(): m for m in moves}
    by_san = {m["san"].lower(): m for m in moves}
    by_san_plain = {m["san"].lower().rstrip("+#"): m for m in moves}

    found = None
    for token in re.findall(r"[A-Za-z][A-Za-z0-9\-+#=]*", cleaned):
        low = token.lower()
        hit = by_uci.get(low) or by_san.get(low) or by_san_plain.get(low.rstrip("+#"))
        if hit:
            found = hit
    return found["uci"] if found else None


def _exact(value, moves):
    low = value.strip().lower()
    for m in moves:
        if m["uci"].lower() == low:
            return m["uci"]
    for m in moves:
        if m["san"].lower() == low or m["san"].lower().rstrip("+#") == low.rstrip("+#"):
            return m["uci"]
    return None


# ---------------------------------------------------------- built-in player

def builtin_move(moves, difficulty):
    """The zero-config opponent.

    It has no rules of its own — it chooses from the moves the board says are
    legal. Difficulty changes its taste, not its strength: this is a sparring
    partner that always answers, not an engine, and it is described that way
    in the interface.
    """
    if not moves:
        return None, "no legal moves"

    if difficulty == "easy":
        return random.choice(moves)["uci"], "chose at random"

    def score(m):
        value = PIECE_VALUE.get((m["captured"] or "").lower(), 0) * 10
        if m["promotion"]:
            value += PIECE_VALUE.get(m["promotion"].lower(), 0) * 8
        if m["check"]:
            value += 4
        return value

    scored = sorted(moves, key=score, reverse=True)
    best = score(scored[0])

    if difficulty == "hard":
        top = [m for m in scored if score(m) == best]
        return random.choice(top)["uci"], f"took the best available (score {best})"

    # medium: usually sensible, sometimes not.
    if best > 0 and random.random() < 0.72:
        top = [m for m in scored if score(m) == best]
        return random.choice(top)["uci"], f"took material (score {best})"
    return random.choice(moves)["uci"], "played quietly"


# ------------------------------------------------------------- llm opponent

SYSTEM_PROMPT = (
    "You are playing chess. You will be given a position in FEN and the "
    "complete list of legal moves. Reply with exactly one move from that "
    "list and nothing else. Use the notation shown in the list. Do not "
    "explain, do not comment, do not offer alternatives."
)

DIFFICULTY_BRIEF = {
    "easy": "Play casually. Do not think deeply; a natural, unambitious move is fine.",
    "medium": "Play a reasonable, solid move.",
    "hard": "Play the strongest move you can find. Consider threats and material.",
}


def list_models(base, key, timeout=6):
    """Model ids the endpoint will admit to, chat models first."""
    request = urllib.request.Request(f"{base}/v1/models")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read()).get("data") or []
    ids = [entry.get("id") for entry in data if entry.get("id")]
    # An embedding model cannot hold a conversation, so never offer one as the
    # chat model just because it happens to be listed first.
    return [i for i in ids if "embed" not in i.lower()] or ids


def resolve_model(base, key, timeout=6):
    try:
        ids = list_models(base, key, timeout)
        return ids[0] if ids else None
    except Exception:  # noqa: BLE001 - a guess that fails costs nothing
        return None


def _endpoint_error(exc):
    """The endpoint's own words, when it bothered to explain itself."""
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None
    try:
        payload = json.loads(body)
    except (ValueError, json.JSONDecodeError):
        return body.strip()[:300] or None
    error = payload.get("error")
    if isinstance(error, dict):
        return error.get("message") or json.dumps(error)[:300]
    if isinstance(error, str):
        return error
    return body.strip()[:300] or None


def llm_chat(config, messages, timeout):
    base = (config.get("url") or DEFAULT_LLM_URL).rstrip("/")
    payload = {
        "messages": messages,
        "temperature": float(config.get("temperature", DEFAULT_TEMPERATURE)),
        "max_tokens": int(config.get("maxTokens", 160)),
        "stream": False,
    }
    key = (config.get("apiKey") or "").strip()
    model = (config.get("model") or "").strip()
    if not model:
        # "Blank means whatever is loaded" is the contract, but some servers —
        # LM Studio among them — refuse a request with no model rather than
        # picking one, and will load on demand once told which. Asking costs
        # one cheap call and turns a hard failure into a working game.
        model = resolve_model(base, key) or ""
    if model:
        payload["model"] = model

    request = urllib.request.Request(
        f"{base}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    if key:
        request.add_header("Authorization", f"Bearer {key}")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        # The endpoint answered and said no. Pass on what it said, rather than
        # reporting it as unreachable — the two need entirely different fixes.
        raise OpponentError(
            f"The endpoint refused the request (HTTP {exc.code}).",
            _endpoint_error(exc) or f"no explanation given by {base}",
        )

    choices = body.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return message.get("content") or ""


def llm_move(config, fen, moves, difficulty):
    """Ask a model, check what it says, and ask again if it was not legal.

    Three attempts, then an honest failure. It never quietly substitutes a
    move of its own — being told the opponent could not answer is more useful
    than wondering why it played something strange.
    """
    timeout = int(config.get("timeout", DEFAULT_TIMEOUT))
    san_list = ", ".join(m["san"] for m in moves)
    attempts = []

    user = (
        f"Position (FEN): {fen}\n"
        f"Legal moves: {san_list}\n\n"
        f"{DIFFICULTY_BRIEF.get(difficulty, DIFFICULTY_BRIEF['medium'])}\n"
        "Reply with one move from the list above."
    )
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = llm_chat(config, messages, timeout)
        except urllib.error.URLError as exc:
            raise OpponentError(
                "Could not reach the model endpoint.",
                f"{getattr(exc, 'reason', exc)} — tried {config.get('url') or DEFAULT_LLM_URL}",
            )
        except TimeoutError:
            raise OpponentError("The model endpoint timed out.", f"after {timeout}s")

        attempts.append({"attempt": attempt, "reply": (reply or "")[:400]})
        move = match_move(reply, moves)
        if move:
            return move, {"attempts": attempts, "accepted_on": attempt}

        messages.append({"role": "assistant", "content": reply or ""})
        messages.append({
            "role": "user",
            "content": (
                "That was not one of the legal moves. Choose exactly one from "
                f"this list and reply with nothing else: {san_list}"
            ),
        })

    raise OpponentError(
        f"The model did not return a legal move in {MAX_ATTEMPTS} attempts.",
        {"attempts": attempts},
    )


# ------------------------------------------------------------- cli opponent

def cli_move(config, fen, moves, difficulty):
    """Run a command line program and read a move out of what it prints.

    The command may use {fen}, {legal} and {difficulty} placeholders; whatever
    it does not use is offered on stdin instead, so simple programs that just
    read a prompt work without any placeholder at all.
    """
    command = (config.get("command") or "").strip()
    if not command:
        raise OpponentError("No CLI command is configured.", None)

    timeout = int(config.get("timeout", DEFAULT_TIMEOUT))
    san_list = ", ".join(m["san"] for m in moves)
    prompt = (
        f"{SYSTEM_PROMPT}\n\nPosition (FEN): {fen}\nLegal moves: {san_list}\n"
        "Reply with one move from the list and nothing else."
    )

    try:
        argv = split_command(command)
    except ValueError as exc:
        raise OpponentError("The CLI command could not be parsed.", str(exc))
    if not argv:
        raise OpponentError("The CLI command is empty.", None)

    argv = [
        part.replace("{fen}", fen)
            .replace("{legal}", san_list)
            .replace("{difficulty}", difficulty or "medium")
        for part in argv
    ]

    argv = resolve_program(argv)

    try:
        proc = subprocess.run(
            argv,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except FileNotFoundError:
        raise OpponentError(f"Command not found: {argv[0]}", None)
    except subprocess.TimeoutExpired:
        raise OpponentError("The CLI opponent timed out.", f"after {timeout}s")
    except OSError as exc:
        raise OpponentError("The CLI opponent could not be started.", str(exc))

    output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    move = match_move(output, moves)
    if move:
        return move, {"exit_code": proc.returncode, "output": output.strip()[:400]}

    raise OpponentError(
        "The CLI opponent did not return a legal move.",
        {"exit_code": proc.returncode, "output": output.strip()[:600]},
    )


def split_command(command):
    r"""Split a command line into argv, correctly on Windows too.

    shlex in non-posix mode keeps the quote characters attached to the token,
    so a perfectly ordinary quoted path — "C:\Program Files\thing.exe" —
    comes out with the quotes still on it and is never found. Strip a matched
    pair from each token; anything else is left exactly as written.
    """
    import shlex

    if os.name == "nt":
        parts = shlex.split(command, posix=False)
        cleaned = []
        for part in parts:
            if len(part) >= 2 and part[0] == part[-1] and part[0] in "\"'":
                part = part[1:-1]
            cleaned.append(part)
        return cleaned
    return shlex.split(command)


def resolve_program(argv):
    """Turn argv[0] into something Windows can actually launch.

    Bare names work on POSIX because the shell searches PATH. On Windows,
    CreateProcess does not apply PATHEXT, so `claude` fails even though
    `claude.cmd` is on PATH — which rules out every npm- or script-installed
    tool, the majority of interesting CLI opponents. shutil.which does apply
    PATHEXT, so resolve through it and hand subprocess a full path.
    """
    if not argv:
        return argv
    from shutil import which

    found = which(argv[0])
    if found:
        return [found] + list(argv[1:])
    return argv


class OpponentError(Exception):
    def __init__(self, message, detail=None):
        super().__init__(message)
        self.message = message
        self.detail = detail


# ------------------------------------------------------------------ routing

def handle_move(body):
    kind = body.get("kind") or "builtin"
    fen = body.get("fen") or ""
    difficulty = body.get("difficulty") or "medium"
    config = body.get("config") or {}
    moves = normalise_moves(body.get("legal"))

    if not moves:
        return {"error": "No legal moves were supplied with the position."}, 400

    if kind in ("builtin", "random"):
        move, detail = builtin_move(moves, difficulty)
        return {"move": move, "detail": {"note": detail}}, 200

    if kind == "http":
        move, detail = llm_move(config, fen, moves, difficulty)
        return {"move": move, "detail": detail}, 200

    if kind == "cli":
        move, detail = cli_move(config, fen, moves, difficulty)
        return {"move": move, "detail": detail}, 200

    return {"error": f"Unknown opponent kind: {kind}"}, 400


def handle_health(body):
    config = (body or {}).get("config") or {}
    http_config = config.get("http") or {}
    base = (http_config.get("url") or DEFAULT_LLM_URL).rstrip("/")

    endpoint = {"url": base, "ok": False, "model": None, "error": None}
    try:
        request = urllib.request.Request(f"{base}/v1/models")
        key = (http_config.get("apiKey") or "").strip()
        if key:
            request.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(request, timeout=4) as response:
            data = json.loads(response.read()).get("data") or []
        endpoint["ok"] = True
        if data:
            endpoint["model"] = data[0].get("id")
    except Exception as exc:  # noqa: BLE001 - reported to the user, never raised
        endpoint["error"] = str(exc)

    cli_config = config.get("cli") or {}
    command = (cli_config.get("command") or "").strip()
    cli = {"configured": bool(command), "ok": False, "error": None}
    if command:
        try:
            argv = split_command(command)
            from shutil import which
            cli["ok"] = bool(argv) and (which(argv[0]) is not None or os.path.isfile(argv[0]))
            if not cli["ok"]:
                cli["error"] = f"not on PATH: {argv[0] if argv else command}"
        except ValueError as exc:
            cli["error"] = str(exc)

    return {"builtin": True, "http": endpoint, "cli": cli}, 200


class Handler(SimpleHTTPRequestHandler):
    server_version = "Chess3D"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if os.getenv("CHESS3D_QUIET"):
            return
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send_json(self, payload, status=200):
        self._no_store = True
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # The page and the model calls share this origin, so no permissive
        # CORS is needed or wanted.
        self.send_header("X-Content-Type-Options", "nosniff")
        if not getattr(self, "_no_store", False):
            # Revalidate every file. This is a development server for a
            # repository people are expected to edit, and a browser quietly
            # serving yesterday's module after a change is a long and
            # thoroughly wasted debugging session.
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_POST(self):
        route = self.path.split("?", 1)[0].rstrip("/") or "/"
        if route not in ("/move", "/health"):
            self._send_json({"error": "not found"}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json({"error": "malformed request"}, 400)
            return

        try:
            if route == "/move":
                payload, status = handle_move(body)
            else:
                payload, status = handle_health(body)
        except OpponentError as exc:
            self._send_json({"error": exc.message, "detail": exc.detail}, 200)
            return
        except Exception as exc:  # noqa: BLE001 - never take the server down
            self._send_json({"error": "The gateway failed.", "detail": repr(exc)}, 500)
            return

        self._send_json(payload, status)


def local_addresses(port):
    out = [f"http://127.0.0.1:{port}"]
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan = s.getsockname()[0]
        s.close()
        if lan and not lan.startswith("127."):
            out.append(f"http://{lan}:{port}")
    except OSError:
        pass
    return out


def main():
    parser = argparse.ArgumentParser(description="Chess3D gateway")
    parser.add_argument("--port", type=int, default=int(os.getenv("CHESS3D_PORT", "8770")))
    parser.add_argument("--host", default=os.getenv("CHESS3D_HOST", "0.0.0.0"),
                        help="0.0.0.0 to allow other devices on your network (default)")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window")
    args = parser.parse_args()

    if not os.path.isdir(WEB_ROOT):
        print(f"web/ not found next to server.py (looked in {WEB_ROOT})", file=sys.stderr)
        return 1

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    addresses = local_addresses(args.port)

    print("Chess3D")
    for url in addresses:
        print(f"  {url}")
    if len(addresses) > 1:
        print("  (the second one works from a phone on the same network)")
    print("  ctrl-c to stop")
    # Request logging goes to stderr, which is unbuffered. Without this flush
    # the addresses sit in a buffer behind it whenever output is redirected or
    # read by a wrapper, and the one thing anyone needs appears last.
    sys.stdout.flush()

    if not args.no_browser:
        # The socket is already bound and listening, so the page is there to be
        # fetched; serve_forever below answers it. Opening from a short timer
        # keeps this off the main thread, which is about to block.
        threading.Timer(0.4, lambda: webbrowser.open(addresses[0])).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
