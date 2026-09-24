#!/usr/bin/env python3
"""AI Chess3D gateway.

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
import sys
import threading
import time
import threading
import webbrowser
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Run as a packaged program (tools/build-exe.py), __file__ points into a
# temporary folder the bootloader unpacked; the game's files sit beside the
# executable instead, where they can be seen and edited like the source ones.
if getattr(sys, "frozen", False):
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.join(ROOT, "web")

DEFAULT_LLM_URL = os.getenv("LLM_URL", "http://127.0.0.1:1234")
DEFAULT_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "90"))
DEFAULT_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.2"))
MAX_ATTEMPTS = 3

# Nothing this application legitimately sends comes near these. They are here
# so a request cannot make the gateway allocate until it falls over.
MAX_REQUEST_BYTES = 1 << 20        # 1 MiB of JSON in
MAX_ENDPOINT_BYTES = 8 << 20       # 8 MiB of model reply back
MAX_DRAIN_BYTES = 8 << 20          # how much of an oversized body to read away

PIECE_VALUE = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}

BOOK_PATH = os.path.join(WEB_ROOT, "openings.json")


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


# ------------------------------------------------------- pre-installed memory

_BOOK = None


def load_book():
    """The opening book, read once from disk.

    Generated by tools/build-book.py, which needs python-chess; the gateway
    only reads the result, so the running application stays standard library
    only. A missing or broken file is not fatal — memory simply has nothing to
    remember and falls back to playing on general principles.
    """
    global _BOOK
    if _BOOK is not None:
        return _BOOK
    try:
        with open(BOOK_PATH, encoding="utf-8") as f:
            data = json.load(f)
        _BOOK = data.get("positions") or {}
    except (OSError, ValueError):
        _BOOK = {}
    return _BOOK


def book_key(fen):
    """Placement, side to move, castling, en passant — no move counters.

    Dropping the counters is what lets a line be recognised however it was
    transposed into, rather than only down the exact move order it was
    recorded from.
    """
    return " ".join((fen or "").split(" ")[:4])


def book_move(fen, moves):
    """What memory knows from this position, if anything.

    The book stores moves most-played first. Memory prefers the main line but
    will take a sideline sometimes, so it is not the identical game every time.
    """
    entry = load_book().get(book_key(fen))
    if not entry:
        return None, None

    legal = {m["uci"] for m in moves}
    known = [uci for uci in entry.get("moves", []) if uci in legal]
    if not known:
        return None, None

    chosen = known[0]
    if len(known) > 1 and random.random() < 0.25:
        chosen = random.choice(known[1:])
    # A name only when this move belongs to exactly one line — at the start
    # every opening shares the position, so nothing there is worth naming.
    return chosen, (entry.get("names") or {}).get(chosen)


def memory_move(moves, difficulty, fen=""):
    """The opponent that is not an AI.

    Two pieces, both of them memory rather than thought. First, a
    pre-installed opening book: if it recognises the position it plays the
    move it was given, which is why the openings are sound and the middlegame
    is not. Once it is out of book it has nothing to recall, and falls back to
    looking only at what each move captures — no search, no evaluation of the
    position, no idea what is about to happen to it.
    """
    if not moves:
        return None, {"note": "no legal moves"}

    from_book, name = book_move(fen, moves)
    if from_book:
        return from_book, {"source": "book", "opening": name,
                           "note": f"book: {name}" if name else "book"}

    if difficulty == "easy":
        return random.choice(moves)["uci"], {"source": "random", "note": "out of book — chose at random"}

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
        return random.choice(top)["uci"], {
            "source": "material", "note": f"out of book — took the best available (score {best})"}

    # medium: usually sensible, sometimes not.
    if best > 0 and random.random() < 0.72:
        top = [m for m in scored if score(m) == best]
        return random.choice(top)["uci"], {
            "source": "material", "note": f"out of book — took material (score {best})"}
    return random.choice(moves)["uci"], {"source": "random", "note": "out of book — played quietly"}


# ------------------------------------------------------------- llm opponent

SYSTEM_PROMPT = (
    "You are playing chess. You will be given a position in FEN and the "
    "complete list of legal moves. Reply with exactly one move from that "
    "list and nothing else. Use the notation shown in the list. Do not "
    "explain, do not comment, do not offer alternatives."
)

DIFFICULTY_BRIEF = {
    "beginner": "You are a beginner. You know how the pieces move but do not calculate. "
                "Play a natural-looking move without checking for threats; it is fine to miss them.",
    "casual": "You are a casual player. Look at most one move ahead, take material that is "
              "clearly free, and do not worry about deeper tactics.",
    "club": "You are a solid club player. Play sensible, principled moves, and check "
            "captures and threats for both sides before you move.",
    "advanced": "You are a strong player. Calculate forcing lines (checks, captures, threats) "
                "several moves ahead and rarely give material away.",
    "expert": "You are an expert. Calculate carefully, weigh every forcing line for both "
              "sides, and play the best move you can find.",
    "master": "Play the strongest move you can find. Calculate as deeply as you can, "
              "consider every threat, and never make a move you have not checked for tactics.",
    # The names used before there were six levels; still accepted.
    "easy": "Play casually. Do not think deeply; a natural, unambitious move is fine.",
    "medium": "Play a reasonable, solid move.",
    "hard": "Play the strongest move you can find. Consider threats and material.",
}


# Cloud instance-metadata services live here and hand out credentials to
# anything that can make a plain HTTP request from inside the machine. No
# chess opponent is ever hosted on them.
BLOCKED_HOSTS = {
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.goog",
}


def check_endpoint(url):
    """Reject anything that is not a plausible model endpoint.

    The URL arrives from the page, which means it arrives from whoever can
    reach this port, so the gateway will fetch whatever it is told to fetch.
    That is fine for the local models this exists to talk to and not fine as
    a general-purpose fetcher, so: HTTP only, and not the metadata service.
    """
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        raise OpponentError(
            "The endpoint must be an http:// or https:// address.",
            f"got {parsed.scheme or 'no'} scheme",
        )
    if not parsed.hostname:
        raise OpponentError("The endpoint has no host.", url[:120])

    host = parsed.hostname.lower().strip("[]")
    if host in BLOCKED_HOSTS or host.endswith(".metadata.internal"):
        raise OpponentError(
            "That address is not somewhere a chess opponent lives.",
            "cloud metadata services are refused",
        )
    return url


def list_models(base, key, timeout=6):
    """Model ids the endpoint will admit to, chat models first."""
    request = urllib.request.Request(f"{check_endpoint(base)}/v1/models")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read(MAX_ENDPOINT_BYTES)).get("data") or []
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
        body = exc.read(MAX_ENDPOINT_BYTES).decode("utf-8", "replace")
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
    base = check_endpoint((config.get("url") or DEFAULT_LLM_URL).rstrip("/"))
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
            body = json.loads(response.read(MAX_ENDPOINT_BYTES))
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


# ----------------------------------------------------------------- the relay

class Relay:
    """A game an AI joins over HTTP, rather than one spawned per move.

    The old command opponent started a fresh process for every move, so the
    player had no memory of the game it was playing — no idea what it had been
    planning, or why its pieces were where they were. Here one client connects
    and stays for the whole game.

    Two waits meet in the middle. The board asks for a move and blocks;
    whatever is playing asks for its turn and blocks. Neither polls: each is
    released the moment the other arrives. The AI side is plain HTTP, so it
    does not matter whether it is an agent on this machine, a script calling an
    API, or a model somewhere else with a fetch tool.
    """

    # How long the board will wait for an AI that may not have connected yet.
    DEFAULT_MOVE_TIMEOUT = 600
    # How long a turn request blocks before answering "nothing yet, ask again".
    DEFAULT_POLL_TIMEOUT = 25
    # A client seen more recently than this counts as connected.
    PRESENCE_WINDOW = 70

    def __init__(self):
        self._cond = threading.Condition()
        self._pending = None     # the position currently waiting for a move
        self._answer = None      # {"id": n, "move": uci}
        self._last_seen = 0.0
        self._last_agent = None
        self._moves_played = 0
        self._seq = 0

    # -- the board's side ---------------------------------------------------

    def request_move(self, fen, moves, difficulty, config=None):
        """Called by the turn loop. Blocks until a connected client answers."""
        timeout = int((config or {}).get("timeout") or self.DEFAULT_MOVE_TIMEOUT)

        with self._cond:
            self._seq += 1
            turn_id = self._seq
            self._pending = {
                "id": turn_id,
                "fen": fen,
                "legal": moves,
                "difficulty": difficulty or "medium",
                "asked_at": time.time(),
            }
            self._answer = None
            self._cond.notify_all()

            deadline = time.monotonic() + timeout
            while True:
                if self._answer and self._answer["id"] == turn_id:
                    move = self._answer["move"]
                    self._answer = None
                    self._pending = None
                    self._moves_played += 1
                    return move, {
                        "source": "relay",
                        "agent": self._last_agent,
                        "note": "played by the connected AI",
                    }

                # A newer request replaced this one — the game moved on (a new
                # game, an undo). Stop waiting rather than hold the thread.
                if self._pending is None or self._pending["id"] != turn_id:
                    raise OpponentError("That turn was superseded.", None)

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._pending = None
                    connected = self._is_connected()
                    raise OpponentError(
                        "No AI answered." if connected
                        else "No AI has connected yet.",
                        f"waited {timeout}s. Copy the instructions and give them to "
                        "an AI that can make HTTP requests.",
                    )
                self._cond.wait(remaining)

    def cancel(self):
        """Drop whatever is waiting — a new game, or the setup screen."""
        with self._cond:
            self._pending = None
            self._answer = None
            self._cond.notify_all()

    # -- the AI's side ------------------------------------------------------

    def wait_for_turn(self, timeout, agent=None):
        """Block until it is the AI's move, or until the wait runs out."""
        timeout = max(1, min(int(timeout or self.DEFAULT_POLL_TIMEOUT), 120))
        with self._cond:
            self._last_seen = time.time()
            if agent:
                self._last_agent = agent[:80]
            deadline = time.monotonic() + timeout

            while self._pending is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(remaining)
                self._last_seen = time.time()

            pending = self._pending
            return {
                "your_turn": True,
                "id": pending["id"],
                "fen": pending["fen"],
                "legal": [m["san"] for m in pending["legal"]],
                "legal_uci": [m["uci"] for m in pending["legal"]],
                "color": "white" if " w " in pending["fen"] else "black",
                "difficulty": pending["difficulty"],
            }

    def submit(self, turn_id, move):
        """Take a move from the AI. Returns (ok, detail)."""
        with self._cond:
            self._last_seen = time.time()
            if self._pending is None:
                return False, "It is not your turn — nothing is waiting for a move."
            if turn_id is not None and int(turn_id) != self._pending["id"]:
                return False, (
                    f"That turn has passed. The board is now on turn "
                    f"{self._pending['id']}; ask for it again."
                )

            resolved = match_move(move, self._pending["legal"])
            if not resolved:
                legal = ", ".join(m["san"] for m in self._pending["legal"])
                return False, f"{move!r} is not a legal move here. Choose one of: {legal}"

            self._answer = {"id": self._pending["id"], "move": resolved}
            self._cond.notify_all()
            return True, resolved

    # -- reporting ----------------------------------------------------------

    def _is_connected(self):
        return bool(self._last_seen) and (time.time() - self._last_seen) < self.PRESENCE_WINDOW

    def status(self):
        with self._cond:
            return {
                "connected": self._is_connected(),
                "waiting_for_move": self._pending is not None,
                "agent": self._last_agent,
                "moves_played": self._moves_played,
                "last_seen": round(time.time() - self._last_seen, 1) if self._last_seen else None,
            }


RELAY = Relay()
SERVED_PORT = [None]


class OpponentError(Exception):
    def __init__(self, message, detail=None):
        super().__init__(message)
        self.message = message
        self.detail = detail


# ------------------------------------------------------------------ routing

def handle_move(body):
    kind = body.get("kind") or "memory"
    fen = body.get("fen") or ""
    difficulty = body.get("difficulty") or "medium"
    config = body.get("config") or {}
    moves = normalise_moves(body.get("legal"))

    if not moves:
        return {"error": "No legal moves were supplied with the position."}, 400

    if kind == "relay":
        move, detail = RELAY.request_move(fen, moves, difficulty, config)
        return {"move": move, "detail": detail}, 200

    # "builtin" and "random" are the names memory shipped under first; keep
    # accepting them so an older page or saved setting still works.
    if kind in ("memory", "builtin", "random"):
        move, detail = memory_move(moves, difficulty, fen)
        return {"move": move, "detail": detail}, 200

    if kind == "http":
        move, detail = llm_move(config, fen, moves, difficulty)
        return {"move": move, "detail": detail}, 200

    return {"error": f"Unknown opponent kind: {kind}"}, 400


def handle_health(body):
    config = (body or {}).get("config") or {}
    http_config = config.get("http") or {}
    base = (http_config.get("url") or DEFAULT_LLM_URL).rstrip("/")

    endpoint = {"url": base, "ok": False, "model": None, "error": None}
    try:
        request = urllib.request.Request(f"{check_endpoint(base)}/v1/models")
        key = (http_config.get("apiKey") or "").strip()
        if key:
            request.add_header("Authorization", f"Bearer {key}")
        with urllib.request.urlopen(request, timeout=4) as response:
            data = json.loads(response.read(MAX_ENDPOINT_BYTES)).get("data") or []
        endpoint["ok"] = True
        if data:
            endpoint["model"] = data[0].get("id")
    except Exception as exc:  # noqa: BLE001 - reported to the user, never raised
        endpoint["error"] = str(exc)

    book = load_book()
    return {
        "memory": {"ok": True, "positions": len(book)},
        "http": endpoint,
        "relay": RELAY.status(),
        "addresses": local_addresses(SERVED_PORT[0]) if SERVED_PORT[0] else [],
    }, 200


class Gateway(ThreadingHTTPServer):
    """The HTTP server, with Windows' port sharing turned off.

    HTTPServer sets SO_REUSEADDR, which on Unix only shortens the TIME_WAIT
    dance. On Windows it means something else entirely: a second process can
    bind a port that is already being listened on, and the two then split
    incoming connections between them unpredictably.

    That is a hijack primitive — anything else running as this user can take
    half the game's traffic — and, more prosaically, it is what happens when
    somebody double-clicks the launcher twice. Two gateways, one port, one of
    them holding the relay game and the other answering half the requests, and
    nothing anywhere saying so.
    """

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def relay_contract(origin):
    """The contract, as data. Served as JSON and rendered as text below."""
    return {
        "game": "chess",
        "you_are": "one of the two players",
        "how_it_works": (
            "Ask for your turn, play a move, repeat until the game ends. "
            "The turn call waits for you, so you do not need to poll."
        ),
        "endpoints": {
            "turn": {
                "method": "GET",
                "url": origin + "/relay/turn",
                "blocks": True,
                "note": (
                    "Waits until it is your move, then returns the position. "
                    "Add ?wait=N to set how many seconds it waits (max 120). "
                    "If it returns your_turn false, nothing is wrong - the "
                    "other player is still thinking. Ask again."
                ),
                "returns": {
                    "your_turn": True,
                    "id": 7,
                    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                    "legal": ["a3", "a4", "Nf3", "..."],
                    "legal_uci": ["a2a3", "a2a4", "g1f3", "..."],
                    "color": "black",
                },
            },
            "move": {
                "method": "POST",
                "url": origin + "/relay/move",
                "content_type": "application/json",
                "body": {"id": 7, "move": "Nf3"},
                "note": (
                    "The id must be the one from the turn you are answering. "
                    "The move must be one of the strings in legal (or in "
                    "legal_uci). The reply is {ok: true} or {ok: false, error} "
                    "explaining what was wrong."
                ),
            },
            "status": {
                "method": "GET",
                "url": origin + "/relay/status",
                "note": "Whether anything is connected and whether a move is wanted.",
            },
        },
        "rules": [
            "Play only moves from the legal list you were given for that turn.",
            "Send back the id you were given; an old id is refused.",
            "Keep going until the game ends. Do not stop after one move.",
            "You play the colour the color field tells you. Play to win.",
        ],
        "formats": {
            "text": origin + "/relay",
            "json": origin + "/relay?format=json",
        },
    }


def relay_contract_text(origin):
    """The same contract for a reader.

    Whatever arrives here has been given an address and nothing else, so this
    has to explain the whole game from cold. It says nothing about terminals
    or SDKs: it is two HTTP calls, and it reads the same to an agent, a model
    with a fetch tool, or someone writing it against an API.
    """
    return f"""CHESS OVER HTTP

You have been given the address of a chess game, and you are one of the two
players. Everything you need is below.

The loop is: ask for your turn, send a move, repeat until the game ends.


1. YOUR TURN

   GET {origin}/relay/turn

   This call waits until it is your move, so it may take a while to answer.
   You do not need to poll. Add ?wait=N to choose how long it waits before
   answering anyway (seconds, up to 120).

   When it is your move:

     {{"your_turn": true,
       "id": 7,
       "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
       "legal": ["a3", "a4", "Nf3", ...],
       "legal_uci": ["a2a3", "a2a4", "g1f3", ...],
       "color": "black"}}

   When it is not:

     {{"your_turn": false}}

   Nothing is wrong when you see that - the other player is still thinking.
   Ask again.


2. YOUR MOVE

   POST {origin}/relay/move
   Content-Type: application/json

     {{"id": 7, "move": "Nf3"}}

   The id must be the one from the turn you are answering. The move must be
   one of the strings you were given in "legal" (or "legal_uci").

   You get back {{"ok": true}}, or {{"ok": false, "error": "..."}} saying what
   was wrong - an illegal move, or a turn that has already passed. The turn
   stays open when a move is refused, so read the reason and send another.


RULES

   - Play only moves from the legal list you were given for that turn.
   - Send back the id you were given. An old one is refused.
   - Keep going. Do not stop after one move - loop until the game ends.
   - You play the colour the "color" field tells you. Play to win.


This page is also available as JSON: {origin}/relay?format=json
"""


class Handler(SimpleHTTPRequestHandler):
    server_version = "AIChess3D"

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

    def _same_origin(self):
        """Refuse anything a browser sends us from another site.

        A cross-origin POST of Content-Type text/plain needs no preflight, so
        without this check any page the player happens to visit can drive this
        gateway: start games, cancel turns, and — through the endpoint
        opponent — make this machine fetch arbitrary URLs and hand back what
        they said. Browsers always attach Origin to such a request; ordinary
        clients like curl or an agent do not send it at all, so the relay
        contract is unaffected.
        """
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("Host") or ""
        return origin in (f"http://{host}", f"https://{host}")

    def _local_page_only(self):
        """Extra gate for the routes only this application's page calls.

        A custom header cannot be set cross-origin without a preflight, and
        this server answers no preflight, so requiring one keeps these routes
        reachable from the page and unreachable from anybody else's.
        """
        return self.headers.get("X-Chess3D") is not None

    def _query(self):
        from urllib.parse import parse_qs, urlsplit
        return {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}

    def do_GET(self):
        route = self.path.split("?", 1)[0].rstrip("/") or "/"

        if not self._same_origin():
            self._send_json({"error": "cross-origin requests are refused"}, 403)
            return

        if route == "/relay/turn":
            params = self._query()
            turn = RELAY.wait_for_turn(
                params.get("wait"),
                agent=self.headers.get("User-Agent") or params.get("agent"),
            )
            if turn is None:
                self._send_json({
                    "your_turn": False,
                    "note": "Not your turn yet. Ask again — this call waits for you.",
                })
            else:
                self._send_json(turn)
            return

        if route == "/relay/status":
            self._send_json(RELAY.status())
            return

        if route == "/relay":
            origin = self._origin()
            wants_json = (
                self._query().get("format") == "json"
                or "application/json" in (self.headers.get("Accept") or "")
            )
            if wants_json:
                self._send_json(relay_contract(origin))
                return
            body = relay_contract_text(origin).encode("utf-8")
            self._no_store = True
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        super().do_GET()

    def _origin(self):
        host = self.headers.get("Host")
        if host:
            return f"http://{host}"
        addresses = local_addresses(SERVED_PORT[0] or 8770)
        return addresses[0]

    def do_POST(self):
        route = self.path.split("?", 1)[0].rstrip("/") or "/"
        if route not in ("/move", "/health", "/relay/move", "/relay/cancel"):
            self._send_json({"error": "not found"}, 404)
            return

        if not self._same_origin():
            self._send_json({"error": "cross-origin requests are refused"}, 403)
            return

        # /move can be told to fetch an arbitrary URL, so it is the one route
        # worth locking to this application's own page.
        if route in ("/move", "/health") and not self._local_page_only():
            self._send_json(
                {"error": "this route is for the game page",
                 "detail": "send the X-Chess3D header"}, 403)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send_json({"error": "malformed request"}, 400)
            return

        if length > MAX_REQUEST_BYTES:
            # Answer properly rather than hanging up mid-upload: read the body
            # away in chunks so it is never held in memory, but only up to a
            # point — past that the sender is not making a mistake.
            drained = 0
            while drained < length and drained < MAX_DRAIN_BYTES:
                chunk = self.rfile.read(min(65536, length - drained))
                if not chunk:
                    break
                drained += len(chunk)
            self.close_connection = True
            self._send_json({"error": "request too large",
                             "detail": f"limit is {MAX_REQUEST_BYTES} bytes"}, 413)
            return

        try:
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw or b"{}")
            if not isinstance(body, dict):
                raise ValueError("expected an object")
        except (ValueError, json.JSONDecodeError):
            self._send_json({"error": "malformed request"}, 400)
            return

        try:
            if route == "/move":
                payload, status = handle_move(body)
            elif route == "/relay/move":
                ok, detail = RELAY.submit(body.get("id"), body.get("move") or "")
                payload = ({"ok": True, "played": detail} if ok
                           else {"ok": False, "error": detail})
                status = 200
            elif route == "/relay/cancel":
                RELAY.cancel()
                payload, status = {"ok": True}, 200
            else:
                payload, status = handle_health(body)
        except OpponentError as exc:
            self._send_json({"error": exc.message, "detail": exc.detail}, 200)
            return
        except Exception as exc:  # noqa: BLE001 - never take the server down
            self._send_json({"error": "The gateway failed.", "detail": repr(exc)}, 500)
            return

        self._send_json(payload, status)


def already_ours(url, timeout=2):
    """Is the thing holding this port our own gateway, or a stranger?

    Worth asking, because "the port is busy" and "the game you are trying to
    start is already open" deserve completely different answers, and the second
    is the common one.
    """
    try:
        request = urllib.request.Request(url + "/relay?format=json")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(65536)).get("game") == "chess"
    except Exception:  # noqa: BLE001 - anything at all means "not ours"
        return False


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
    parser = argparse.ArgumentParser(description="AI Chess3D gateway")
    parser.add_argument("--port", type=int, default=int(os.getenv("CHESS3D_PORT", "8770")))
    parser.add_argument("--host", default=os.getenv("CHESS3D_HOST", "0.0.0.0"),
                        help="0.0.0.0 to allow other devices on your network (default)")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window")
    args = parser.parse_args()

    if not os.path.isdir(WEB_ROOT):
        print(f"web/ not found next to the program (looked in {WEB_ROOT})", file=sys.stderr)
        return 1

    try:
        server = Gateway((args.host, args.port), Handler)
    except OSError as exc:
        # Before complaining, find out what is actually there. The commonest
        # cause by far is this program already running — in which case the
        # player wants to play, not to read about a port.
        existing = f"http://127.0.0.1:{args.port}"
        if already_ours(existing):
            print("AI Chess3D is already running.")
            print(f"  {existing}")
            if not args.no_browser:
                print("  opening it")
                webbrowser.open(existing)
            else:
                print("  (close that window first if you meant to restart it)")
            return 0

        print(f"Could not listen on port {args.port}: {exc}", file=sys.stderr)
        print("Something else on this machine is using that port.", file=sys.stderr)
        print(f"Start this one on another: --port {args.port + 1}", file=sys.stderr)
        return 1
    SERVED_PORT[0] = args.port
    addresses = local_addresses(args.port)

    print("AI Chess3D")
    for url in addresses:
        print(f"  {url}")
    if len(addresses) > 1:
        print("  (the second one works from a phone on the same network,")
        print("   which also means anyone on that network can reach the game;")
        print("   run with --host 127.0.0.1 to keep it to this machine)")
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
