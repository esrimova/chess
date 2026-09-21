# AI Chess3D — build checklist

**Repo:** https://github.com/esrimova/chess
**Working dir:** `C:\Proyectos\Chess`
**Status:** complete. Implementation, backend pass and frontend pass all done;
every defect found in testing is fixed.

---

## How this file works

Every item carries three checks, filled in three separate passes over the whole
list rather than item by item:

1. **Implementation** — built and working during development.
2. **Backend testing** — real end-to-end verification against the running system.
   No mocks, no stubs, no fake doubles standing in for the thing under test.
3. **Frontend testing** — driven in a real browser as a user would: clicking,
   dragging, scrolling, at desktop and phone shapes.

`[x]` done · `[—]` genuinely not applicable, with the reason given.

**Order of work:** implement every item → backend-test every item → frontend-test
every item. That order is what this build followed.

### The log rule

Where something did not work as expected and the approach changed, a **Log**
line records what was tried, why it failed, and what replaced it. This file is
the project's memory: a later session reads it to learn where things stand and
which roads are already known to be dead ends. **Never delete a log entry** — a
failed approach is information.

### How to run it all

```bash
python server.py        # then open http://127.0.0.1:8770
python run-tests.py     # 85 tests: logic, geometry, gateway
```

### Architectural rule that governs every item

The 3D layer never knows chess rules. The rules layer never knows 3D. They meet
only in the turn loop, and speak only in square names. Any item that breaks this
is not done, however well it appears to work.

---

## 0. Project setup

**0.1 Repo skeleton** — structure, `.gitignore`, MIT licence, throwaway terminal-chess
files removed.
- [x] Implementation
- [x] Backend testing — `tests/test_gateway.py` serves and fetches every shipped file.
- [—] Frontend testing — a folder layout has no user-facing surface.

**0.2 Vendored libraries** — Three.js 0.169.0, chess.js 1.0.0-beta.8, pinned, no build
step, no npm at runtime.
- [x] Implementation
- [x] Backend testing — every module fetched over HTTP and asserted non-empty.
- [x] Frontend testing — page boots and plays with zero external requests.

> **Log (0.2):** the addons (`RoomEnvironment`, `BufferGeometryUtils`) ship with
> bare `from 'three'` imports, which a browser can only resolve through an
> import map — and Node cannot resolve at all, so the geometry tests could not
> import the piece set. Rewrote both vendored files to import
> `./three.module.js` directly and deleted the import map. One moving part
> fewer, and the same modules now load in the browser and under Node.
> A test asserts no vendored file asks for bare `'three'` again.

---

## 1. The stage

**1.1 Renderer and loop** — antialiasing, ACES filmic tone mapping, sRGB output, soft
shadows, DPR capped at 2, delta-time loop, `ResizeObserver`.
- [x] Implementation
- [x] Backend testing — module loads and constructs headlessly.
- [x] Frontend testing — renders at every aspect from 360×640 to 1920×800; no console
  output of any kind across a full load.

**1.2 Lighting and environment** — key with shadows, fill, hemisphere, generated
environment map for reflections.
- [x] Implementation
- [x] Backend testing — theme lighting blocks validated for completeness.
- [x] Frontend testing — judged by eye in all three themes.

> **Log (1.2):** fog distances were fixed per theme and written for the ordinary
> desktop view (~13 units). On a phone the camera pulls back past 30 units to
> fit the board across the width, which put the whole board inside the fog band
> and washed it to a flat brown. Fog near/far now slide with the camera
> (`Stage.updateFog`), so the band always starts just behind the board.
> Found only in the frontend pass — the numbers looked perfectly reasonable.

---

## 2. The coordinate contract

**2.1 Square ↔ world mapping** — `squareToWorld` / `worldToSquare`, and nothing else
in the app converts by hand.
- [x] Implementation
- [x] Backend testing — all 64 squares round-trip; all four corners of every square
  resolve to that square; off-board points return null rather than an edge square.
- [x] Frontend testing — every click through the whole frontend pass resolved to the
  square under the cursor at every camera angle.

**2.2 Board geometry** — 64 squares, a1 dark, white nearest at the default camera,
frame, rank and file labels on all four sides.
- [x] Implementation
- [x] Backend testing — a1/h1/a8/h8 colours and orientation asserted.
- [x] Frontend testing — labels legible in all three themes, including at phone size.

---

## 3. Pieces (procedural default set)

**3.1 Lathe shapes** — pawn, rook, bishop, queen, king from lathe profiles.
- [x] Implementation
- [x] Backend testing — all build, have normals, contain no NaN, sit exactly on the
  board, fit inside their square, and run p < r < n < b < q < k.
- [x] Frontend testing — inspected at playing distance and zoomed, in all three themes.

**3.2 The knight** — composed silhouette; must read as a horse.
- [x] Implementation
- [x] Backend testing — asserted asymmetric above the foot, where the others are
  surfaces of revolution.
- [x] Frontend testing — reads as a horse head at playing distance and at phone size.

**3.3 Piece factory and placement** — shared geometry, colour from the material,
renders any FEN.
- [x] Implementation
- [x] Backend testing — 32 pieces drawn from exactly 6 geometries.
- [x] Frontend testing — arbitrary FENs rendered correctly throughout.

> **Log (3.1) — merge failure.** `mergeGeometries` refuses to mix indexed and
> non-indexed geometry. Lathes and boxes are indexed, `ExtrudeGeometry` is not,
> so the knight silently produced `null` and the whole set failed to build.
> Every part is now dropped to non-indexed before merging (`merge()` in
> `pieces.js`). Duplicated vertices cost nothing at this size.
>
> **Log (3.1) — pieces below the board.** The shared foot profile dipped a few
> thousandths below y=0 at the wider base radii, z-fighting with the square.
> Rather than hand-tune each profile, every piece is now translated so its
> bounding box sits exactly on zero.
>
> **Log (3.1) — the set was undersized.** First built, the widest piece was
> 0.48 of a square across and the king under one square tall; on screen they
> read as counters marooned in large empty squares. A real tournament king is
> close to twice its square. The whole set is now scaled by `SET_SCALE = 1.45`
> in one place, and the geometry test asserts a floor as well as a ceiling on
> both width and height so this cannot silently drift back.
>
> **Log (3.1) — the king's cross vanished.** Modelled at a realistic thinness it
> was 5 px wide on screen, white on white, and invisible — and the cross *is*
> the king's silhouette. Deliberately thickened well past realism.
>
> **Log (3.2) — the knight faced the wrong way.** Knights were rotated ±90° to
> face the enemy, as a set on a table does. That points the silhouette along the
> board, so from either player's seat the piece is a blank slab — the one
> arrangement in which nobody can see what it is. They now sit a half turn
> apart, which keeps the outline in the same plane and shows a horse to both
> players. A deliberate departure from how a real set is arranged, for the
> thing the piece exists to do.
>
> **Log (3.2) — silhouette too soft.** The first outline read as a smooth hook.
> The mane, ear and jaw are now cut as steps and undercuts rather than a
> continuous curve.

---

## 4. Rules

**4.1 Game wrapper** — chess.js behind our own interface, zero 3D references.
- [x] Implementation
- [x] Backend testing — 29 logic tests.
- [x] Frontend testing — exercised by every move played in the browser.

**4.2 Full rule coverage** — castling, en passant, promotion, check, checkmate,
stalemate, insufficient material, threefold, fifty-move.
- [x] Implementation
- [x] Backend testing — each case asserted, plus perft: start position to depth 3
  (20 / 400 / 8902), Kiwipete to depth 2 (48 / 2039), a promotion-heavy position
  (24 / 496), and the full Evergreen Game played to mate.
- [x] Frontend testing — in the browser: a complete game to Qxf7#; castling both
  sides with the rook moving in the same breath; en passant removing the pawn
  beside rather than under; promotion to queen and to knight through the dialog.

> **Log (4.2):** the first check-not-mate test used a FEN that was actually
> Fool's mate, so `status.over` was correctly true and the test was wrong, not
> the code. Replaced with a position where the king has four flight squares.
> Worth recording because the failure looked like a rules bug for a minute.

---

## 5. Picking and selection

**5.1 Raycast to square** — accurate at every camera angle, mouse and touch.
- [x] Implementation
- [x] Backend testing — the coordinate contract it rests on is fully covered.
- [x] Frontend testing — every move in the frontend pass went through real
  `PointerEvent`s at real screen coordinates.

**5.2 Selection state machine** — select, light legal targets, move, deselect, switch
selection, refuse input while animating.
- [x] Implementation
- [x] Backend testing — legal-move generation asserted against the board.
- [x] Frontend testing — select lights the right squares; clicking an empty square
  deselects; an opponent's piece cannot be selected on your turn; clicking another
  of your own pieces switches selection.

**5.3 Hover feedback** — cursor and square highlight on desktop, suppressed on touch.
- [x] Implementation
- [—] Backend testing — a cursor has no server-side surface.
- [x] Frontend testing — pointer cursor over movable pieces, default elsewhere.

---

## 6. Camera

**6.1 Orbit, zoom, pan** — ctrl-drag orbits a full 360°, scroll zooms, polar clamped,
damped, **plain click reserved for pieces**.
- [x] Implementation
- [x] Backend testing — framing solved and asserted at seven window shapes.
- [x] Frontend testing — ctrl-drag turns the board and selects nothing; plain drag
  moves the camera by exactly zero; azimuth ran past 4½ turns without clamping;
  polar clamped to 0.12–1.51 so the camera never goes under the board; wheel zoom
  clamps at 5.5 and 46.

**6.2 Touch equivalents** — one finger pieces, two fingers orbit, pinch zoom.
- [x] Implementation
- [—] Backend testing — gestures have no server-side surface.
- [x] Frontend testing — one finger moves the camera not at all; two fingers travelling
  together orbit without zooming; two fingers spreading zoom without orbiting.

**6.3 Camera presets** — flip, spin, reset.
- [x] Implementation
- [x] Backend testing — settled angles asserted numerically.
- [x] Frontend testing — flip settles exactly half a turn, spin exactly a full turn,
  reset returns to the framing for the current window shape.

> **Log (6.1) — fixed distances do not survive a phone.** The camera used two
> hard-coded distances chosen by breakpoint. A camera's field of view is
> vertical, so the horizontal one narrows with the aspect ratio: on a phone the
> board's corners projected to x = ±1.5, hanging well off both sides. Replaced
> the guess with `CameraRig.frame()`, which projects the board's own corners and
> solves for the distance that contains them — correct at every window shape,
> and still correct if the board or field of view ever changes. Seven shapes now
> all frame at 84–86% of the screen.
>
> **Log (6.1) — the angle was backwards.** Having fixed the distance, phone
> portrait used only 25% of the screen height. First attempt tilted the camera
> *lower* on tall screens, which made it worse — `phi` is measured from straight
> overhead, so a larger value is a lower camera, and a lower camera flattens the
> board into a thin band. Inverted: tall screens now get a squarer, more
> overhead view (0.34 rad), wide screens keep the low cinematic angle (0.62).
> Phone portrait went from 25% to 39% of the height, which is within a whisker
> of the theoretical maximum at that aspect. The chosen angle is abandoned the
> moment the player moves the camera themselves (`userAdjusted`) — re-framing on
> resize is helpful, overriding someone's view is not.

---

## 7. Motion

**7.1 Tween queue** — lift, arc, land, settle; board locked while running.
- [x] Implementation
- [x] Backend testing — driven deterministically by a controlled clock.
- [x] Frontend testing — every move in the browser went through it.

**7.2 Special-case motion** — capture, castling, en passant, promotion.
- [x] Implementation
- [x] Backend testing — move flags asserted.
- [x] Frontend testing — castling moves both pieces together; captures leave by
  shrinking and sinking; promotion swaps the mesh on arrival.

> **Log (7.1):** pieces share one material per colour, so a capture cannot fade
> out — changing opacity would fade the entire army. Captured pieces shrink and
> sink through the board instead. Noted here because it looks like an odd choice
> until you know why.

---

## 8. Turn loop and the engine boundary

**8.1 Engine interface** — `getMove(fen, legal, signal)`; human and remote are both
implementations and nothing else can tell them apart.
- [x] Implementation
- [x] Backend testing — identical request shape asserted across all opponent kinds.
- [x] Frontend testing — human, built-in, and a real local model all played through
  the same loop with no branching outside `buildEngines`.

**8.2 The loop** — ask, validate, animate, repeat; **the engine never mutates the board**.
- [x] Implementation
- [x] Backend testing — an illegal proposal is refused and the position is unchanged.
- [x] Frontend testing — a full game to checkmate, plus games against the built-in
  opponent and against Qwen.

> **Log (8.2) — the board could lock permanently.** `busy` guards the board
> while a piece travels, and nothing cleared it when travel was *abandoned*
> rather than finished. Start a new game while a move is animating and the new
> board ignored every click for the rest of the session, looking broken for no
> visible reason. Found by starting a second game in the frontend pass. Now
> `idle()` clears it, called from `startGame`, `undo` and `openSetup`. `undo`
> also no longer refuses to run while busy — being stuck is precisely when you
> want it.

---

## 9. Gateway

**9.1 Static server** — serves the page, same origin as the model calls, binds on the LAN.
- [x] Implementation
- [x] Backend testing — started as a real process, every shipped file fetched.
- [x] Frontend testing — the whole frontend pass ran against it.

**9.2 `/move` route** — same request and response shape whichever opponent is behind it.
- [x] Implementation
- [x] Backend testing — asserted across built-in, HTTP and CLI.
- [x] Frontend testing — exercised by every AI game played in the browser.

**9.3 `/health` route** — honest reachability, so the UI can say so before move time.
- [x] Implementation
- [x] Backend testing — reachable, unreachable, and missing-command cases.
- [x] Frontend testing — *Test connection* reported
  `Endpoint reachable — huihui-qwen3-vl-4b-instruct-abliterated`.

> **Log (9.1) — stale modules.** The browser cached JavaScript across edits, and
> a fix that was already on disk appeared not to work. Half an hour of a
> confusing debug went to this. The server now sends
> `Cache-Control: no-cache, must-revalidate` for static files. This is a
> development server for a repository people are expected to edit; quietly
> serving yesterday's module is the wrong default.

---

## 10. Opponents

**10.1 Pre-installed memory** — the one opponent that is not an AI. Ships
permanently, zero configuration, and proved the turn loop before any model was
involved.
- [x] Implementation
- [x] Backend testing — returns a legal move at every difficulty; plays from the
  book and reports it; names a line only when the move identifies one; recognises
  a position however it was transposed into; falls back out of book and says so;
  prefers the capture on hard out of book; still answers to its old `builtin` name.
- [x] Frontend testing — played the Petrov in the browser with the move panel
  naming it, then left the book and fell back when taken out of the line.

> **Log (10.1) — the label had to become true.** This shipped as "Built-in", a
> material heuristic with no memory of anything. Renamed to "Pre-installed
> memory", which would have been a lie, so it was given something to remember:
> an opening book of 42 named lines, 382 positions, generated by
> `tools/build-book.py` and shipped as `openings.json`. The generator needs
> python-chess; the gateway only reads the JSON, so the running application is
> still standard library only. Out of book the old heuristic remains, and the
> interface says which of the two is playing.
>
> **Log (10.1) — an option nobody asked for.** A "Two players, one board" mode
> was built alongside the opponents and kept through a restructure that did not
> list it, on the reasoning that removing working code was the greater harm.
> That reasoning was wrong: the scope is the user's to set, and carrying an
> unrequested feature forward is not a favour. Removed entirely — the option,
> the second human engine, the hint, and the README section. A setting saved
> while it existed now falls back to the first opponent instead of leaving the
> dropdown on no value.
>
> **Log (10.1) — naming a line too early is a lie.** The book first stored one
> name per position, so the opening move reported "Alekhine Defence" — every
> line in the book shares the starting position, and sorting alphabetically
> picked one. Names now attach to a *move*, and only when that move belongs to
> exactly one line, so nothing is named until something is actually identified.

**10.2 HTTP / OpenAI-compatible opponent** — base URL, optional model, timeout,
temperature.
- [x] Implementation
- [x] Backend testing — against a real HTTP service speaking the real protocol, and
  against the real local model.
- [x] Frontend testing — **Qwen3-VL-4B in LM Studio played Nf6 against e4** through
  the full UI, thinking indicator and all.

**10.3 Reply parsing and validation** — tolerate fences, preambles and reasoning;
validate; re-ask; fail honestly.
- [x] Implementation
- [x] Backend testing — fenced, JSON, chattering and reasoning replies all parsed; an
  illegal move is sent back with the reason and the retry accepted; three failures
  produce an error and **never** a substituted move.
- [x] Frontend testing — a dead endpoint produced a visible error naming the real
  reason, the status line read *Stopped — the opponent could not move*, and no move
  was played.

**10.4 AI Connect (the relay)** — the app waits on its port; the AI joins and
plays the whole game over one connection.
- [x] Implementation
- [x] Backend testing — a real relay client in a thread doing exactly what the
  published instructions say: the turn handed over and the move played; the turn
  call blocking rather than returning empty; SAN and UCI both accepted; an illegal
  move refused with the reason while the turn stays open; a stale id refused; a
  move with nothing waiting refused; the board giving up honestly when nothing
  connects; a cancel releasing a waiting board; presence reported; three turns
  over one connection.
- [x] Frontend testing — **a game played through the browser against a client
  connected from a shell**: `1.e4 c5 2.Nf3 d6`, the Sicilian, with the moves
  arriving over the relay and the board showing the connected agent in its detail.

> **Log (10.2) — a blank model is not always "whatever is loaded".** The
> contract inherited from the AI Interface project is that a blank model field
> means use whatever is loaded. LM Studio refuses such a request outright
> (`No models loaded`) rather than picking one, so the documented default failed
> against the very endpoint it was written for. A blank field now asks
> `/v1/models` and names the first non-embedding model, which also triggers
> LM Studio's load-on-demand. Embedding models are filtered out explicitly —
> they are frequently listed first and cannot hold a conversation.
>
> **Log (10.2) — "unreachable" was a lie.** An endpoint that answered and said
> no was reported as unreachable, which points at entirely the wrong fix. HTTP
> errors are now caught separately and the endpoint's own message is passed
> through verbatim.
>
> **Log (10.4) — spawning was the wrong shape, and the user said so.** The CLI
> opponent started a fresh process for every move, which meant the player had
> no memory of the game it was in: one position, one answer, then gone. It also
> made the setup a command line the player had to compose correctly, and every
> Windows bug below came from that. Replaced by the relay, where the app waits
> on its port and the AI connects to it — one session for the whole game, and
> the same two HTTP calls whether the other end is an agent, a script, or a
> model with a fetch tool. The spawning code, and the two fixes below, are gone
> with it; they are kept here because they are what a future attempt to spawn
> processes on Windows will run into again.
>
> **Log (10.4) — bare command names could not launch on Windows.** Found by
> trying to play the `claude` CLI as an opponent. npm installs it as a `.cmd`
> shim, and Windows `CreateProcess` does not apply `PATHEXT` for a bare name,
> so `subprocess` raised *Command not found: claude* for a program plainly on
> `PATH` — `shutil.which` finds it, `CreateProcess` does not. That ruled out
> every npm- and script-installed tool, which is most of the interesting CLI
> opponents. `resolve_program()` now resolves `argv[0]` through `shutil.which`
> and hands subprocess a full path; an unresolvable name is left alone so the
> error still names what was asked for. Two tests cover it.
>
> **Log (10.4) — Windows quoting.** `shlex.split(posix=False)` keeps the quote
> characters attached to each token, so an ordinary quoted path —
> `"C:\Program Files\thing.exe"` — came back with the quotes still on it and was
> never found. Every CLI test failed with a puzzling *Command not found* naming
> a path that plainly existed. `split_command()` now strips a matched pair per
> token on Windows.

---

## 11. Configuration

**11.1 Config screen** — endpoint or CLI, fields, working test button, persisted.
- [x] Implementation
- [x] Backend testing — `/health` covers what the button reports.
- [x] Frontend testing — fields show and hide per opponent; test button reported a real
  result; every setting survived a reload.

**11.2 Difficulty** — passed through, honest about what it means.
- [x] Implementation
- [x] Backend testing — changes the built-in opponent's choices; reaches the model's brief.
- [x] Frontend testing — selected, persisted, and reflected in play.

**11.3 Side selection** — play white or black; board and camera orient accordingly.
- [x] Implementation
- [x] Backend testing — engine assignment asserted.
- [x] Frontend testing — as Black the opponent opened with d3 unprompted and the camera
  swung to θ = π.

---

## 12. Themes

**12.1 Theme descriptor** — one JSON file; adding a theme is a JSON edit.
- [x] Implementation
- [x] Backend testing — every theme asserted to declare background, board (light, dark,
  frame), pieces (both colours), highlights and lighting; ids unique; default present.
- [x] Frontend testing — all three load and apply.

**12.2 Three themes** — Classic Wood, Marble, Neon, each restyling **background, board
and pieces together**.
- [x] Implementation
- [x] Backend testing — completeness asserted per theme.
- [x] Frontend testing — inspected individually; each reads as one designed object
  rather than a recoloured default, and highlight colours stay legible in all three.

**12.3 Live switching** — mid-game, no reload, position intact.
- [x] Implementation
- [x] Backend testing — materials are repointed, not rebuilt.
- [x] Frontend testing — switched mid-game; position, selection and history survived;
  32 pieces still present.

---

## 13. Interface chrome

**13.1 Loading animation** — shown while the scene builds, leaves cleanly.
- [x] Implementation
- [—] Backend testing — no server-side surface.
- [x] Frontend testing — plays, then lifts onto a board that is already drawn.

**13.2 HUD** — turn, check and game-over states, move list, captured pieces, undo,
new game, theme picker, camera buttons.
- [x] Implementation
- [—] Backend testing — no server-side surface.
- [x] Frontend testing — move list read `1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#`,
  captured pieces appeared, undo stepped back correctly, the menu left the game cleanly.

**13.3 Promotion picker** — appears, offers four, blocks the turn.
- [x] Implementation
- [x] Backend testing — promotion moves carry the piece in their UCI.
- [x] Frontend testing — appeared on promotion, produced a queen and a knight, closed
  after choosing.

**13.4 Thinking and error states** — indicator, cancel, visible explanation on failure.
- [x] Implementation
- [x] Backend testing — every failure path returns a message and a detail.
- [x] Frontend testing — indicator appeared and cleared around a real Qwen turn; a dead
  endpoint produced a red toast quoting the real reason.

> **Log (13.1) — a permanent loading screen.** Boot waited on two animation
> frames before lifting the loader. Browsers do not run animation frames in a
> background tab, so a page opened in one — middle-clicked, restored with a
> session, opened from a link — sat on *Setting the board* indefinitely.
> Reproduced exactly: `document.hidden === true` and boot never completed. The
> wait is now raced against a 400 ms timeout: take the frame if it comes, carry
> on without it if it does not. This is a real-world failure, not a test
> artifact, and it would have been invisible in any tab that had focus.

---

## 14. Responsive

**14.1 Phone layout** — board fills the screen, no horizontal scroll, safe areas respected.
- [x] Implementation
- [x] Backend testing — framing solved at 360×640, 390×780, 768×1024, 1024×768,
  1440×900, 1920×800 and 780×390: all fit inside the free band, portrait using
  87–90% of the width and landscape 84–86% of the band, including the worst case
  of the board turned 45° on a phone.
- [x] Frontend testing — **at a true 389 px viewport**, with the narrow CSS rules
  actually active: setup sheet 357 px with even gutters, top bar full width, move
  panel spanning the width above a row of controls within thumb reach, nothing
  overlapping, no horizontal scroll, all 64 squares visible and labels legible.

**14.2 Performance on a phone** — triangle budget, capped DPR, workable shadows.
- [x] Implementation
- [x] Backend testing — the full set is six shared geometries totalling roughly 15k
  triangles for 32 pieces; DPR capped at 2.
- [x] Frontend testing — rendered without stutter at every size tested.

> **Log (14.1) — testing a narrow viewport at all.** The automation window
> would not resize: the tab reported 1536 px wide whatever the window did, so
> the first pass constrained the stage element instead and measured projected
> corners. That covers the camera but leaves the CSS breakpoints unproven,
> because media queries key off the viewport, not an element. Resolved by
> loading the app in a **390 px iframe**, which has a viewport of its own:
> `matchMedia('(max-width: 760px)')` reports true inside it and the narrow rules
> genuinely apply. A real narrow-viewport test, not a simulation.
>
> **Log (14.1) — the board was framed behind the furniture.** Seen properly at
> 389 px, the board sat in a band in the middle with dead space above it and the
> move panel taking the bottom third. The cause: the canvas fills the window but
> the chrome sits on top of it, so centring in the canvas centres the board
> behind the top bar, the panel and the controls. Now `freeBand()` measures the
> vertical strip nothing is covering, `Stage.setViewShift()` offsets the
> projection in screen space to centre the board there, and the vertical framing
> margin is scaled to that band. The shift is screen-space, so it holds however
> the board is turned. Only chrome spanning more than 70% of the width counts,
> so the desktop layout — where the panel and controls sit in the corners with
> the board between them — is unaffected.
>
> **Log (14.1) — measuring through the shift.** First version applied the view
> shift and *then* solved the distance, which counted the deliberate offset as
> overflow and pulled the camera 30% too far back. The shift is a pure
> translation, so the fit is now solved against an unshifted camera and the
> shift applied afterwards.
>
> **Log (14.1) — the move list costs a third of a phone.** It now starts
> collapsed below 760 px, header and all, so it is one tap away rather than
> occupying the space the board needs. Toggling it reframes the board.

---

## 15. Repository

**15.1 README** — what it is, how to run it, how to plug in an endpoint or a CLI, how to
add a theme, how to add an opponent.
- [x] Implementation
- [—] Backend testing — prose has no runtime surface.
- [—] Frontend testing — as above.

**15.2 Push to GitHub** — committed and pushed, runs from a fresh clone.
- [x] Implementation
- [x] Backend testing — the full suite passes from the repository root.
- [—] Frontend testing — no user-facing surface.

---

## 16. Generated piece sets — deferred, not built

Not part of this build, by agreement: the procedural set ships as the default so a
fresh clone plays with no assets and no generation.

Once wanted, a signature set goes through the AI Interface pipeline —
`tools/t2i.py` → `tools/to3d.py` → `scripts/finish-mesh.py`, previewed with
`scripts/render-glb.py` — and is added as a theme. Six shapes only; black and
white share geometry. `scripts/inspect-glb.py` gives the bounds needed to
normalise six independently generated meshes to one consistent piece height.

- [ ] Implementation
- [ ] Backend testing
- [ ] Frontend testing

---

## Test inventory

| Suite | Tests | Covers |
|---|---|---|
| `tests/logic.test.mjs` | 29 | coordinate contract, rules, perft, a full game |
| `tests/geometry.test.mjs` | 11 | the generated piece set |
| `tests/test_gateway.py` | 45 | serving, health, all three opponents, reply parsing |
| **Total** | **85** | all passing |

The gateway suite's last test plays against whatever real model is listening on
`127.0.0.1:1234` and skips with a notice when nothing is. It ran for real against
Qwen3-VL-4B in LM Studio.

---

## Known gaps

1. **Difficulty is advisory for language models.** It is precise for the built-in
   opponent and a line in the prompt for everything else. Said plainly in the UI.
3. **The built-in opponent is not an engine.** It chooses from the legal moves the
   board hands it and has no search. It is described as a sparring partner.
4. **Generated piece sets** — section 16, deferred.
