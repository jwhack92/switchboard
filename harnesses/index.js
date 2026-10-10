// Harness registry.
// main.js loads this file after its reloader line: a change here needs an app restart.
//
// A "harness" is a CLI that drives a model and records its sessions on disk —
// `claude`. Each one owns its transcript layout, its
// transcript format, and its launch flags; the rest of the app addresses them
// only through the shape below.
//
// Note the name: `agent` already means a Claude *subagent* elsewhere in this
// codebase (session_cache.agentId, subagentType), so a harness is deliberately
// not called an agent.
//
// Every harness module exports:
//
//   id              string; this fork has no harness column, so it is
//                   effectively always the default
//   label           display name
//   binary          the executable name
//   available()     is this harness usable on this machine
//   sessionsRoot()  directory holding all its transcripts
//   listFolders()   folder keys under that root
//   folderPath(f)   folder key → absolute directory
//   listTranscripts(f)         absolute transcript paths in a folder
//   transcriptPath(row)        cached row → absolute transcript path
//   readSessionFile(file, folder, projectPath) → session row, or null
//   buildLaunchArgs({ sessionId, isNew, options }) → argv after the binary

const claude = require('./claude');

const HARNESSES = { [claude.id]: claude };

const DEFAULT_HARNESS = claude.id;

/** Look up a harness by id, falling back to Claude for rows written before
 *  the harness column existed (and for any unknown value). */
function getHarness(harnessId) {
  return HARNESSES[harnessId] || HARNESSES[DEFAULT_HARNESS];
}

/** Every registered harness, whether or not it is usable here. */
function allHarnesses() {
  return Object.values(HARNESSES);
}

/** Harnesses that can actually be used on this machine. */
function availableHarnesses() {
  return allHarnesses().filter(h => h.available());
}


/**
 * What an OSC 9;4 progress report means for a session's busy state.
 *
 * The title is the program's own word. A progress report (`4;1`, `4;2` or
 * `4;3`) may raise busy only while the latest title does not say idle.
 * The end of progress (`4;0`) is never read as idle: any program in a plain
 * terminal sends it (a download, for one), and reading it as idle would make
 * the app speak. main.js keeps its own skip of level 0 as well.
 */
function progressBusyState({ level, titleIdle }) {
  if (level === '1' || level === '2' || level === '3') return titleIdle === true ? null : 'busy';
  return null;
}

const TITLE_SEEN_MAX = 16;

/**
 * Should main.js write the log line of this title, and remember its character?
 *
 * Title lines were almost the whole log. So one is written only when the
 * title's state changes, and once per session for each unknown first
 * character (an unknown title's character is remembered in `seen`, at most
 * TITLE_SEEN_MAX of them): that is what catches a new spinner character.
 * Pure: `seen` is the caller's to change, and a missing one counts as empty.
 */
function titleLogDue({ state, previous, codePoint, seen }) {
  const remember = state === 'none' && !(seen && seen.has(codePoint))
    && (seen ? seen.size : 0) < TITLE_SEEN_MAX;
  const due = state !== previous || remember;
  return { due, remember };
}

module.exports = { HARNESSES, DEFAULT_HARNESS, getHarness, allHarnesses, availableHarnesses,
  progressBusyState, titleLogDue };
