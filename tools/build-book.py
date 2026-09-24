#!/usr/bin/env python3
"""Build the pre-installed opening book.

    pip install chess
    python tools/build-book.py

A development script, not part of the running application: it needs
python-chess, the gateway does not. It expands the named lines below into a
map of position -> the moves memory knows from that position, and writes
`web/openings.json`. The page loads that file and nothing
else — the book is data, and the repository stays standard library only.

Positions are keyed by the first four fields of the FEN (placement, side to
move, castling rights, en passant square). The halfmove and fullmove counters
are deliberately dropped so a line is recognised however it was transposed
into.
"""

from __future__ import annotations

import collections
import json
import os
import sys

try:
    import chess
except ImportError:
    print("This script needs python-chess:  pip install chess", file=sys.stderr)
    raise SystemExit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "openings.json")

# Main lines only, and short ones. The point is that memory plays a sound,
# recognisable opening and then hands over — not that it memorises theory
# twenty moves deep.
LINES = {
    # --- 1. e4 -----------------------------------------------------------
    "Ruy Lopez": "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O",
    "Ruy Lopez, Berlin": "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5",
    "Italian Game": "e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O",
    "Two Knights": "e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 c3 d6 O-O O-O",
    "Scotch Game": "e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Be3 Qf6 c3 Nge7",
    "Petrov Defence": "e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Be7 O-O Nc6",
    "Four Knights": "e4 e5 Nf3 Nc6 Nc3 Nf6 Bb5 Bb4 O-O O-O d3 d6",
    "Vienna Game": "e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7 d4 O-O",
    "King's Gambit": "e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6 d4 d6",
    "Sicilian, Najdorf": "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6",
    "Sicilian, Dragon": "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O",
    "Sicilian, Classical": "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 Be7",
    "Sicilian, Sveshnikov": "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6",
    "Sicilian, Accelerated Dragon": "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 c4 Nf6 Nc3 d6 Be2 Nxd4",
    "Sicilian, Taimanov": "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6 Be2 Nf6",
    "Sicilian, Closed": "e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6 f4 Nf6",
    "Sicilian, Alapin": "e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6",
    "French Defence": "e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7",
    "French, Tarrasch": "e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6 Ne2 cxd4",
    "French, Advance": "e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 Nh6",
    "Caro-Kann": "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7",
    "Caro-Kann, Advance": "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Qb6 Nc3 Nc6",
    "Scandinavian": "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6",
    "Pirc Defence": "e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O c6",
    "Alekhine Defence": "e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6 O-O Be7",
    "Modern Defence": "e4 g6 d4 Bg7 Nc3 d6 Nf3 Nf6 Be2 O-O O-O c6",

    # --- 1. d4 -----------------------------------------------------------
    "Queen's Gambit Declined": "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6",
    "Queen's Gambit Accepted": "d4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6 dxc5 Qxd1",
    "Slav Defence": "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4",
    "Semi-Slav": "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5",
    "Nimzo-Indian": "d4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6",
    "Queen's Indian": "d4 Nf6 c4 e6 Nf3 b6 g3 Ba6 b3 Bb4+ Bd2 Be7 Bg2 c6",
    "King's Indian": "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6",
    "Grunfeld": "d4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7 Nf3 c5",
    "Benoni": "d4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6 Nf3 Bg7",
    "Dutch Defence": "d4 f5 g3 Nf6 Bg2 e6 Nf3 Be7 O-O O-O c4 d6",
    "London System": "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bg3 O-O Bd3 c5",
    "Catalan": "d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4 Qc2 a6",

    # --- others ----------------------------------------------------------
    "English Opening": "c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6",
    "English, Symmetrical": "c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7 O-O O-O",
    "Reti Opening": "Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O d3 c5",
    "Bird Opening": "f4 d5 Nf3 g6 e3 Bg7 Be2 Nf6 O-O O-O",
}


def key_for(board: chess.Board) -> str:
    """Position identity: placement, side, castling, en passant. No counters."""
    return " ".join(board.fen().split(" ")[:4])


def main() -> int:
    book: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    # Which named lines each move continues. A move is only worth naming when
    # it belongs to exactly one of them: at the start every line shares the
    # position, so "e4" identifies nothing and should stay unnamed.
    move_lines: dict[tuple, set] = collections.defaultdict(set)

    for name, line in LINES.items():
        board = chess.Board()
        for san in line.split():
            try:
                move = board.parse_san(san)
            except ValueError:
                print(f"  ! {name}: illegal move {san}", file=sys.stderr)
                break
            key = key_for(board)
            book[key][move.uci()] += 1
            move_lines[(key, move.uci())].add(name)
            board.push(move)

    positions = {}
    for key, counter in sorted(book.items()):
        ordered = sorted(counter, key=lambda m: (-counter[m], m))
        entry = {"moves": ordered}
        named = {
            uci: sorted(move_lines[(key, uci)])[0]
            for uci in ordered
            if len(move_lines[(key, uci)]) == 1
        }
        if named:
            entry["names"] = named
        positions[key] = entry

    out = {
        "_comment": (
            "Pre-installed opening memory. Generated by tools/build-book.py from "
            "named lines; the gateway only reads it. Keys are the first four "
            "fields of a FEN, so a position is recognised however it was reached. "
            "A move carries a name only when it belongs to exactly one line."
        ),
        "lines": len(LINES),
        "positions": positions,
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write("\n")

    total_moves = sum(len(v["moves"]) for v in out["positions"].values())
    named = sum(len(v.get("names", {})) for v in out["positions"].values())
    print(f"{len(LINES)} lines -> {len(book)} positions, {total_moves} moves "
          f"({named} of them identify a line by name)")
    print(f"written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
