/**
 * The search, off the page's thread.
 *
 * A strong level thinks for seconds. Run on the page's own thread that would
 * freeze the board, the camera and the clock for the whole of it, so the
 * search lives here and the page only hears when it is done. Cancelling is the
 * page terminating this worker, which is why nothing here needs to be
 * interruptible.
 */

import { chooseMove } from './search.js';

self.onmessage = (event) => {
  const { id, fen, history, level, override } = event.data;
  try {
    const result = chooseMove(fen, history, level, override);
    self.postMessage({
      id,
      ok: true,
      uci: result ? result.uci : null,
      score: result ? result.score : 0,
      depth: result ? result.depth : 0,
      nodes: result ? result.nodes : 0,
      ms: result ? result.ms : 0,
    });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
