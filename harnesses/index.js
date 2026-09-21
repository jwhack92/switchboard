// Harness registry.
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
 * `4;1/2/3` start or update progress, `4;0` ends it. The catch is that `4;0`
 * also arrives when nothing was running, and any child process in the PTY can
 * emit these — so it only clears a busy state the terminal title does not
 * currently contradict. The title comes from the CLI itself and is the more
 * trustworthy signal; a subprocess's progress bar must never be able to report
 * the CLI as idle while it is visibly working.
 *
 * This fork previously skipped `4;0` entirely (main.js, "unreliable as an idle
 * signal") because it had no title veto to lean on. Adopting this is what makes
 * that skip unnecessary — but only once a title-busy signal is actually wired.
 */
function progressBusyState({ level, titleBusy }) {
  if (level === '0') return titleBusy ? null : 'idle';
  if (level === '1' || level === '2' || level === '3') return 'busy';
  return null;
}

module.exports = { HARNESSES, DEFAULT_HARNESS, getHarness, allHarnesses, availableHarnesses,
  progressBusyState };
