'use strict';
// pty-guard.js: the one gate in front of a session's pty.
//
// Loaded after the electron-reloader line of main.js: a change here needs an app restart.
//
// This is the only code that writes to, resizes or kills a session's pty.
// Nothing reaches a terminal that is stopping, closed or ended; a size that
// comes before the first output is held and applied once after it; a second
// kill is not sent while the first has neither ended the terminal nor stalled.
// task-manager.js keeps its own killSent flag for the Tasks runner: that flag
// is the second copy of the "kill once" rule.
//
// Pure: no Electron, no window, no other module, and nothing looked up by an
// id. Everything the guard keeps for a session lives on that session's record,
// in session.ptyGate, and goes where the record goes. Every wait goes through
// the handed-in setTimer. Loading this file has no side effect.

/** Errors of a terminal's connection that are ordinary while it goes away. */
const BENIGN_CODES = ['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED'];

const messageOf = (error) => String(error && error.message !== undefined ? error.message : error);

/** A terminal's width or height: a whole number from 1 to 32767. */
const isSize = (n) => Number.isInteger(n) && n >= 1 && n <= 32767;

/**
 * createPtyGuard({ log, setTimer, clearTimer, onStall, killPty })
 *   log         { debug, info, warn, error }
 *   setTimer    (fn, ms) => handle; clearTimer(handle) calls it off
 *   onStall     (session) => void: a kill has not ended its terminal after 8 s
 *   killPty     (pty) => void: how a kill reaches the pty; a throw is a failed
 *               kill. Default pty.kill(); main.js hands in pty-close.js closePty.
 */
function createPtyGuard({ log, setTimer, clearTimer, onStall, killPty = (pty) => pty.kill() }) {
  /**
   * The record's gate object, made the first time the guard keeps something
   * for it. A gate the record already carries is used as it is: a field it
   * lacks counts as false or null.
   */
  function gateOf(session) {
    if (!session.ptyGate) {
      session.ptyGate = { hasOutput: false, pendingSize: null, killRequested: false, killSent: false, stalled: false, failed: false, closed: false };
    }
    return session.ptyGate;
  }

  /** True when nothing may reach this terminal any more. */
  const shut = (session, gate) => Boolean(session.exited || gate.ended || gate.killRequested || gate.closed);

  function callOffStall(gate) {
    if (gate.stallTimer == null) return;
    clearTimer(gate.stallTimer);
    gate.stallTimer = null;
  }

  /** Answers whoever waits in whenStopped: true for an end, false for the 8 s mark. */
  function settle(gate, ended) {
    const answer = gate.settle;
    gate.waiting = null;
    gate.settle = null;
    if (answer) answer(ended);
  }

  /** Typed data. true: it reached the pty. false: dropped. Typing is never held. Never throws. */
  function write(session, data) {
    if (!session) return false;
    const gate = gateOf(session);
    if (shut(session, gate)) return false;
    try {
      session.pty.write(data);
      return true;
    } catch (error) {
      if (!gate.writeWarned) {
        gate.writeWarned = true;
        log.warn('[pty-guard] write failed: ' + messageOf(error), error);
      }
      return false;
    }
  }

  /**
   * A new size. true: it reached the pty. 'held': kept until the first output,
   * where only the last one is applied. false: dropped. Never throws.
   */
  function resize(session, cols, rows) {
    if (!session) return false;
    const gate = gateOf(session);
    if (shut(session, gate)) return false;
    if (!isSize(cols) || !isSize(rows)) return false;
    if (gate.hasOutput !== true) {
      gate.pendingSize = { cols, rows };
      return 'held';
    }
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch (error) {
      const message = messageOf(error);
      if (message.includes('already exited')) {
        gate.closed = true;
        if (!gate.resizeDropLogged) {
          gate.resizeDropLogged = true;
          log.debug('[pty-guard] resize dropped: the pty has already exited');
        }
      } else if (!gate.resizeWarned) {
        gate.resizeWarned = true;
        log.warn('[pty-guard] resize failed: ' + message, error);
      }
      return false;
    }
  }

  /** Runs 8 s after a kill that went through, unless the terminal ended first. It never calls the pty. */
  function onStallTimer(session, gate) {
    gate.stallTimer = null;
    if (session.exited || gate.ended) return;
    gate.stalled = true;
    gate.failed = false;
    gate.killSent = false;
    log.warn(gate.killTag + ' session=' + gate.killId + ' has not ended 8000 ms after the kill');
    settle(gate, false);
    // No report for the forced kill at quit: the flags, the line and the answer above are all it gets.
    if (gate.killForced) return;
    try { onStall(session); } catch { /* a report that fails must not come out of the timer */ }
  }

  /**
   * One kill. `tag` is the caller's log tag; `sessionId` is text for the two
   * log lines under that tag and nothing else. A kill that went through writes
   * no line. `force` sends a kill even when one was already sent.
   *   { ok: true }                                   sent now
   *   { ok: true, already: true }                    one was sent and has neither stalled nor failed
   *   { ok: false, error: 'not running' }            no session, or it has ended
   *   { ok: false, error: 'stop failed', cause }     the pty's kill threw
   */
  function kill(session, tag, { force = false, sessionId } = {}) {
    if (!session || session.exited || (session.ptyGate && session.ptyGate.ended)) return { ok: false, error: 'not running' };
    const gate = gateOf(session);
    if (gate.killSent === true && !force) return { ok: true, already: true };
    const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown';
    gate.killRequested = true;
    try {
      killPty(session.pty);
    } catch (error) {
      // A stall timer that waits for an earlier kill is left alone.
      gate.failed = true;
      gate.stalled = false;
      gate.killSent = false;
      log.error(tag + ' session=' + id + ' kill failed: ' + messageOf(error), error);
      return { ok: false, error: 'stop failed', cause: error };
    }
    gate.killSent = true;
    gate.killTag = tag;
    gate.killId = id;
    gate.killForced = force === true;
    callOffStall(gate);
    const timer = setTimer(() => onStallTimer(session, gate), 8000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    gate.stallTimer = timer;
    if (!gate.waiting) gate.waiting = new Promise((resolve) => { gate.settle = resolve; });
    return { ok: true };
  }

  /**
   * Called for every chunk of output. The first one arms one 0 ms step; that
   * step marks the terminal as printed and applies the size that was held,
   * through resize above. It sets no buffer hold and knows of none.
   */
  function markOutput(session) {
    if (!session) return;
    const gate = gateOf(session);
    if (gate.hasOutput === true || gate.outputArmed) return;
    gate.outputArmed = true;
    setTimer(() => {
      gate.hasOutput = true;
      const size = gate.pendingSize;
      gate.pendingSize = null;
      if (size) resize(session, size.cols, size.rows);
    }, 0);
  }

  /** Called first in the exit code: the terminal has ended. */
  function noteExit(session) {
    if (!session) return;
    const gate = gateOf(session);
    gate.ended = true;
    callOffStall(gate);
    gate.pendingSize = null;
    settle(gate, true);
  }

  /**
   * Listens for errors of the terminal and of its input socket. After a stop
   * or an exit, and for the ordinary socket errors, an error is a debug line;
   * anything else on a live terminal goes to onFault(error).
   */
  function watchPtyErrors(session, ptyProcess, onFault) {
    if (session) gateOf(session);
    const onError = (error) => {
      if (!session || shut(session, gateOf(session))) {
        log.debug('[pty-guard] pty error after a stop or an exit: ' + messageOf(error));
        return;
      }
      if (BENIGN_CODES.includes(error && error.code)) {
        log.debug('[pty-guard] pty error ignored (' + error.code + '): ' + messageOf(error));
        return;
      }
      try { onFault(error); } catch { /* a report that fails must not become a fault of its own */ }
    };
    try { ptyProcess.on('error', onError); } catch { /* a terminal object without events */ }
    try {
      if (ptyProcess._agent && ptyProcess._agent.inSocket) ptyProcess._agent.inSocket.on('error', onError);
    } catch { /* no input socket to listen on */ }
  }

  /** Read-out: 'none', 'stopping', 'stalled' or 'failed'. It makes no gate. */
  function stopState(session) {
    if (!session || session.exited) return 'none';
    const gate = session.ptyGate;
    if (!gate || gate.ended) return 'none';
    if (gate.failed) return 'failed';
    if (gate.stalled) return 'stalled';
    if (gate.killRequested) return 'stopping';
    return 'none';
  }

  /**
   * Read-out: a promise of true once the terminal has ended, or of false once
   * the 8 s mark of the kill that is waiting has passed. False at once when no
   * kill is waiting.
   */
  function whenStopped(session) {
    if (!session) return Promise.resolve(false);
    const gate = session.ptyGate;
    if (session.exited || (gate && gate.ended)) return Promise.resolve(true);
    if (gate && gate.waiting) return gate.waiting;
    return Promise.resolve(false);
  }

  return { write, resize, kill, markOutput, noteExit, watchPtyErrors, stopState, whenStopped };
}

module.exports = { createPtyGuard };
