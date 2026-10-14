const path = require('path');
const fs = require('fs');

/**
 * Every change of a live session's id (fork, plan-accept, /clear) goes through one rekey().
 * The clear pass follows a /clear only by a note that carries the terminal's own tag.
 * resolveInputSession follows the newest earlier id for 5 s, for typed input and resize only.
 * keyOf answers the key under which the live list holds a record.
 * Call init(ctx) once with shared context.
 * Loads after the reloader line of main.js: a change here needs an app restart.
 */
let PROJECTS_DIR, activeSessions, sendToOwner, rekeyOwner, log, rekeyMcpServer;
let copySessionAssignment, rekeyPlanLinks, rekeyScheduleSession, copyStar, readClearOrigin, broadcast, ownerId, now, setTimer, clearTimer;
let copyHandoffOff;
let clearFolders = new Map();

function init(ctx) {
  for (const state of clearFolders.values()) {
    if (state.timer) clearTimer(state.timer);
  }
  clearFolders = new Map();
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  // A fork is only meaningful to the window displaying the session, and the
  // session's id changes, so ownership has to be re-keyed in the same breath.
  // Both default to no-ops so the unit tests can init without Electron.
  sendToOwner = ctx.sendToOwner || (() => false);
  rekeyOwner = ctx.rekeyOwner || (() => {});
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
  copySessionAssignment = ctx.copySessionAssignment || (() => {});
  rekeyPlanLinks = ctx.rekeyPlanLinks || (() => {});
  rekeyScheduleSession = ctx.rekeyScheduleSession || (() => {});
  copyStar = ctx.copyStar || (() => {});
  copyHandoffOff = ctx.copyHandoffOff || (() => {});
  readClearOrigin = ctx.readClearOrigin || (() => null);
  broadcast = ctx.broadcast || (() => {});
  ownerId = ctx.ownerId || (() => null);
  now = ctx.now || (() => Date.now());
  setTimer = ctx.setTimer || setTimeout;
  clearTimer = ctx.clearTimer || clearTimeout;
}

/**
 * The key under which the live list holds THIS record (the same object), or
 * null. Two callers ask, both in main.js: the exit code, before it touches the
 * id a terminal started with, and the stall report, for the id the record
 * lives under at that moment. It tries startId when one is given, then
 * session.realSessionId, then looks through the list.
 */
function keyOf(session, startId) {
  if (!session || !activeSessions) return null;
  if (startId != null && activeSessions.get(startId) === session) return startId;
  if (session.realSessionId != null && activeSessions.get(session.realSessionId) === session) return session.realSessionId;
  for (const [key, held] of activeSessions) {
    if (held === session) return key;
  }
  return null;
}

/**
 * An old id stops pointing at the terminal that moved on as soon as another
 * terminal is started under that id. main.js calls this when open-terminal
 * starts a terminal under `id`. From then on resolveLiveSession (main.js)
 * follows the id to no other terminal, so once the new terminal has ended a
 * Stop under the id is answered 'not running', without rekeyedTo.
 * Every record of the live list that has `id` among its priorIds gets a NEW
 * array without it; the array is never changed in place.
 */
function forgetPriorId(id) {
  if (!activeSessions || typeof id !== 'string' || id === '') return;
  for (const session of activeSessions.values()) {
    if (session && Array.isArray(session.priorIds) && session.priorIds.includes(id)) {
      session.priorIds = session.priorIds.filter((prior) => prior !== id);
    }
  }
}

// --- Fork / plan-accept detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
function readNewSessionSignals(filePath, fileId) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytesRead = fs.readSync(fd, buf, 0, 524288, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let planContent = false;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.planContent) planContent = true;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    let clearHead = false;
    let looked = 0;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { break; }
      if (entry && entry.type === 'file-history-snapshot') continue;
      if (++looked > 40) break;
      if (marksClear(entry, fileId)) { clearHead = true; break; }
    }
    return { forkedFrom, planContent, slug, parentSessionId, hasSnapshots, clearHead };
  } catch {
    return { forkedFrom: null, planContent: false, slug: null, parentSessionId: null, hasSnapshots: false, clearHead: false };
  }
}

function marksClear(entry, fileId) {
  if (!entry || typeof entry !== 'object') return false;
  const content = entry.message && entry.message.content;
  const mark = (entry.type === 'user' && typeof content === 'string' && content.includes('<command-name>/clear</command-name>'))
    || (entry.type === 'attachment' && !!entry.attachment && entry.attachment.hookName === 'SessionStart:clear');
  return mark && (entry.sessionId === undefined || entry.sessionId === fileId);
}

function validClearNote(note, id) {
  return !!note && typeof note === 'object' && !Array.isArray(note)
    && note.v === 1 && note.session_id === id && note.source === 'clear'
    && typeof note.host_token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(note.host_token)
    && Number.isFinite(note.ts);
}

/** Read tail of old session file for ExitPlanMode and slug */
function readOldSessionTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const hasExitPlanMode = tail.includes('ExitPlanMode');
    // Extract slug from tail (last occurrence)
    let slug = null;
    const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
    if (slugMatches) {
      const last = slugMatches[slugMatches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
      if (last) slug = last[1];
    }
    return { hasExitPlanMode, slug };
  } catch {
    return { hasExitPlanMode: false, slug: null };
  }
}

function holderOf(id, except) {
  const keyed = activeSessions.get(id);
  if (keyed !== undefined && keyed !== except) return id;
  for (const [key, held] of activeSessions) {
    if (held !== except && !held.exited && Array.isArray(held.priorIds) && held.priorIds.includes(id)) return key;
  }
  return null;
}

function rekey(session, oldId, newId, kind, signals) {
  if (newId === oldId) return false;
  const holderKey = holderOf(newId, session);
  if (holderKey !== null) {
    log.warn(`[session-transition] refused old=${oldId} new=${newId} kind=${kind} holder=${holderKey}`);
    return false;
  }
  log.info(`[session-transition] ${oldId} → ${newId} (${kind})`);
  session.knownJsonlFiles = new Set(signals.currentFiles);
  session.realSessionId = newId;
  // Update slug from new session
  if (signals.slug) session.sessionSlug = signals.slug;
  // Jason's answer CK-A (forgetPriorId): a missed id another record holds now is not an earlier id of this one.
  const missed = (signals.missedIds || []).filter((id) => holderOf(id, session) === null);
  // Remember where this session used to live. A re-key DELETES the old
  // key, so anything still holding the old id — most importantly a
  // tear-off whose adopt payload has not been delivered yet — would
  // otherwise look it up, find nothing, and conclude the session had
  // exited, when in fact it is alive under a new id and still billing.
  // See the adopt delivery in main.js's createWindow.
  session.priorIds = [...(session.priorIds || []), ...missed, oldId];
  session.rekeyedAtMs = now();
  activeSessions.delete(oldId);
  activeSessions.set(newId, session);
  // Re-key MCP server to match new session ID
  rekeyMcpServer(oldId, newId);
  // Ownership must move with the id BEFORE the notification, or the send
  // below would look up a session id nobody owns any more.
  rekeyOwner(oldId, newId);
  const followUps = [
    ['copySessionAssignment', copySessionAssignment],
    ['rekeyPlanLinks', rekeyPlanLinks],
    ['rekeyScheduleSession', rekeyScheduleSession],
  ];
  if (kind === 'clear') followUps.push(['copyStar', copyStar]);
  followUps.push(['copyHandoffOff', copyHandoffOff]);
  for (const [name, followUp] of followUps) {
    try {
      followUp(oldId, newId);
    } catch (err) {
      log.warn(`[session-transition] follow-up failed name=${name} old=${oldId} new=${newId} error=${err && err.message}`);
    }
  }
  if (kind === 'clear') {
    sendToOwner(newId, 'session-forked', oldId, newId, 'clear', { clearedAtMs: signals.clearedAtMs });
  } else {
    sendToOwner(newId, 'session-forked', oldId, newId);
  }
  broadcast('session-owner-changed', { sessionId: newId, windowId: ownerId(newId) });
  broadcast('session-owner-changed', { sessionId: oldId, windowId: null });
  return true;
}

function clearNoteMemo() {
  const notes = new Map();
  return (id) => {
    if (!notes.has(id)) notes.set(id, readClearOrigin(id));
    return notes.get(id);
  };
}

function isClearEligible(session, folder) {
  return session.projectFolder === folder && !!session.hostToken && !session.exited && !session.isPlainTerminal
    && !!session.knownJsonlFiles && !(session.forkFrom && !session.realSessionId);
}

function walkBack(note, key, priorIds, noteOf) {
  const earlier = Array.isArray(priorIds) ? priorIds : [];
  const missed = [];
  const visited = new Set([note.session_id]);
  let current = note;
  for (let hops = 0; ; hops++) {
    if (typeof current.cleared_from !== 'string') return missed;
    const prior = Array.isArray(current.prior) ? current.prior.filter((id) => typeof id === 'string').slice(0, 8) : [];
    for (const id of [current.cleared_from, ...prior]) {
      if (id === key || earlier.includes(id)) return missed;
      missed.push(id);
    }
    const nextId = current.cleared_from;
    if (hops === 8 || visited.has(nextId)) return null;
    const next = noteOf(nextId);
    if (!validClearNote(next, nextId) || next.host_token !== note.host_token) return null;
    visited.add(nextId);
    current = next;
  }
}

function clearPass(folder, currentFiles, noteOf) {
  const eligible = [...activeSessions].filter(([, session]) => isClearEligible(session, folder));
  let state = clearFolders.get(folder);
  if (eligible.length === 0) {
    if (state && state.timer) clearTimer(state.timer);
    clearFolders.delete(folder);
    return;
  }
  if (!state) {
    state = { files: new Map(), timer: null };
    clearFolders.set(folder, state);
  }
  const knownToAll = (file) => eligible.every(([, session]) => session.knownJsonlFiles.has(file));
  const held = (id) => {
    if (holderOf(id) === null) return false;
    state.files.delete(id);
    return true;
  };
  const end = (id, outcome) => {
    const entry = state.files.get(id);
    if (entry) entry.outcome = outcome;
    else state.files.set(id, { firstSeenMs: now(), outcome });
  };

  for (const [id, entry] of [...state.files]) {
    if (!currentFiles.includes(id + '.jsonl') || (entry.outcome !== null && knownToAll(id + '.jsonl'))) state.files.delete(id);
  }

  const agreeing = [];
  currentFiles.forEach((file, order) => {
    const id = path.basename(file, '.jsonl');
    const entry = state.files.get(id);
    if (entry ? entry.outcome !== null : knownToAll(file)) return;
    if (held(id)) return;
    const note = noteOf(id);
    if (!validClearNote(note, id)) {
      if (!entry) state.files.set(id, { firstSeenMs: now(), outcome: null });
      if (now() - state.files.get(id).firstSeenMs >= 60000) {
        end(id, 'no note');
        log.info(`[clear-detect] new=${id} tag=none not followed: no note after 60 s`);
      }
      return;
    }
    const tag = note.host_token.slice(0, 8);
    const terminal = eligible.find(([, session]) => session.hostToken === note.host_token);
    if (!terminal) {
      end(id, 'no terminal');
      log.info(`[clear-detect] new=${id} tag=${tag} not followed: no live terminal has this tag`);
      return;
    }
    const missed = walkBack(note, terminal[0], terminal[1].priorIds, noteOf);
    if (missed === null) {
      end(id, 'no lead');
      log.warn(`[clear-detect] new=${id} tag=${tag} not followed: old id does not lead back to this terminal`);
      return;
    }
    agreeing.push({ id, session: terminal[1], ts: note.ts, tag, missed, order, look: entry ? 'recheck' : 'first' });
  });

  for (const [key, session] of eligible) {
    const mine = agreeing.filter((found) => found.session === session);
    if (mine.length === 0) continue;
    const chosen = mine.reduce((best, found) => (found.ts > best.ts ? found : best));
    const missedIds = [];
    const add = (id) => { if (id !== chosen.id && !missedIds.includes(id)) missedIds.push(id); };
    [...chosen.missed].reverse().forEach(add);
    mine.filter((found) => found !== chosen).sort((a, b) => a.ts - b.ts || a.order - b.order).forEach((found) => add(found.id));
    const clearedAtMs = chosen.ts * 1000;
    if (rekey(session, key, chosen.id, 'clear', { clearedAtMs, missedIds, currentFiles })) {
      log.info(`[clear-detect] new=${chosen.id} tag=${chosen.tag} followed: old=${key} look=${chosen.look} afterMs=${now() - clearedAtMs}`);
    } else {
      end(chosen.id, 'refused');
    }
  }

  for (const id of [...state.files.keys()]) held(id);
  const waits = [...state.files.values()].some((entry) => entry.outcome === null);
  if (waits && !state.timer) {
    state.timer = setTimer(() => {
      state.timer = null;
      let files;
      try {
        files = fs.readdirSync(path.join(PROJECTS_DIR, folder)).filter(f => f.endsWith('.jsonl'));
      } catch { clearFolders.delete(folder); return; }
      clearPass(folder, files, clearNoteMemo());
    }, 2000);
  } else if (!waits && state.timer) {
    clearTimer(state.timer);
    state.timer = null;
  }
}

/** Detect fork or plan-accept transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  const noteOf = clearNoteMemo();
  clearPass(folder, currentFiles, noteOf);

  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath, newId);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent) {
        // Fork file with only snapshots (no user turn yet) — match immediately
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} matching snapshot-only fork file=${newId}`);
          // Fall through to matching logic — will match via the fork-snapshot path below
        } else {
          let stale = false;
          try {
            const mtime = fs.statSync(path.join(folderPath, newFile)).mtimeMs;
            if (Date.now() - mtime > 3600000) stale = true;
          } catch {}
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      // Fork file with only snapshots — no user turn yet, but this session is waiting for a fork
      if (!matched && signals.hasSnapshots && session.forkFrom && !session.realSessionId && !signals.clearHead && !validClearNote(noteOf(newId), newId)) {
        matched = true;
      }

      if (session.forkFrom && !matched) {
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      // Plan-accept: shared slug + planContent + old session has ExitPlanMode
      if (!matched && signals.planContent && signals.slug) {
        const oldFilePath = path.join(folderPath, sessionId + '.jsonl');
        const oldTail = readOldSessionTail(oldFilePath);
        if (oldTail.hasExitPlanMode && oldTail.slug === signals.slug) {
          // Temporal check: new file created within 30s of old file's last modification
          try {
            const oldMtime = fs.statSync(oldFilePath).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            if (Math.abs(newMtime - oldMtime) < 30000) {
              matched = true;
            }
          } catch {}
        }
      }

      if (matched) {
        const kind = signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept';
        if (rekey(session, sessionId, newId, kind, { ...signals, currentFiles })) {
          break; // Only one transition per session per flush
        }
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}

/** For typed input and resize only (main.js terminal-input, terminal-resize): a key pressed while a re-key lands must not be lost. Follows only the NEWEST earlier id, for 5 seconds. Everything else that must follow an old id for good uses resolveLiveSession in main.js; stop-session follows neither. */
function resolveInputSession(sessionId, nowMs) {
  const session = activeSessions.get(sessionId);
  if (session !== undefined) return { id: sessionId, session };
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  for (const [key, held] of activeSessions) {
    if (held.exited || !Array.isArray(held.priorIds) || held.priorIds[held.priorIds.length - 1] !== sessionId) continue;
    if (typeof held.rekeyedAtMs === 'number' && nowMs - held.rekeyedAtMs <= 5000) return { id: key, session: held };
  }
  return null;
}


module.exports = { init, detectSessionTransitions, keyOf, forgetPriorId, resolveInputSession };
