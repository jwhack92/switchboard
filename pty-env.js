// Environment for PTY children.
// main.js loads this file after its reloader line: a change here needs an app restart.
//
// Three jobs:
//
// 1. Strip Electron internals that cause nested Electron apps (or node-pty
//    inside them) to malfunction.
//
// 2. Strip inherited Claude Code session markers (see CLAUDE_SESSION_VARS).
//
// 3. Guarantee a UTF-8 character encoding. An app launched from Finder or the
//    Dock on macOS inherits no shell environment, so LANG/LC_* are simply
//    absent — launchd does not set them. Locale-sensitive tools then fall back
//    to the "standard C encoding", which on macOS means Mac OS Roman. `pbcopy`
//    is the one users notice: it reads UTF-8 bytes as Mac OS Roman, so an
//    agent response copied out of a session arrives on the clipboard as
//    "‚Ä¶‚Äî‚Üí" instead of "…—→" (issue #89).
//
//    LC_CTYPE alone is deliberate. It fixes character handling and nothing
//    else — collation, dates, and number formatting stay on the system
//    default rather than being forced to some guessed region.
//
// Job 2 is ours; upstream's version of this module has only 1 and 3. Keep it:
// dropping it does not fail loudly, it makes sessions silently not exist.

// Environment a running Claude Code session stamps onto everything it spawns.
//
// If Switchboard is itself started from inside a Claude Code session — a
// terminal, a task runner, an agent — these are inherited by the Electron
// process and then handed straight to every PTY it opens. The CLI sees
// CLAUDE_CODE_CHILD_SESSION, decides it is a nested child, and prints:
//
//   Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
//
// which is self-defeating here: sessions started from Switchboard are never
// written to ~/.claude/projects, so they never appear in Switchboard.
//
// The messaging socket/token and session id are worse than useless downstream —
// they point the new session at the PARENT session's IPC channel.
// Note: Switchboard sets CLAUDECODE=1 itself for PLAIN terminals (see the
// claudeShim in main.js) to explain that sessions start from the + button.
// Stripping it here is still correct — that assignment happens after this
// spread, so the deliberate one survives and only an inherited one is removed.
const CLAUDE_SESSION_VARS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

function buildPtyEnv(sourceEnv, platform = process.platform) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      !CLAUDE_SESSION_VARS.includes(k) &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION'
    )
  );

  // macOS ONLY, and the narrowness is the point.
  //
  // The problem is launchd-specific: a Finder or Dock launch inherits no shell
  // environment at all. macOS is also the only platform where the bare value
  // "UTF-8" names a real locale, so it is the only one where this is even a
  // valid thing to set.
  //
  // On Windows it is actively harmful, and in exactly the direction this fix
  // exists to prevent. Git Bash is the default shell here (shell-profiles.js)
  // and is spawned as a login shell, so it runs /etc/profile.d/lang.sh, whose
  // autodetect is guarded on this very variable:
  //     test -z "${LC_ALL:-${LC_CTYPE:-$LANG}}" && export LANG=$(locale -uU)
  // A non-empty LC_CTYPE makes that guard false, so LANG is never set — and
  // MSYS's setlocale rejects bare "UTF-8", leaving LC_CTYPE as "C". Measured:
  // without it, LANG=en_US.UTF-8 and `printf '…→' | wc -m` gives 3; with it,
  // LANG empty, LC_CTYPE="C", and wc -m gives 7 — bytes counted as characters.
  // So the injection REMOVES UTF-8 handling on the platform this fork runs on.
  //
  // Do not "generalise" this to C.UTF-8: macOS does not ship that locale.
  //
  // Only when the parent handed us nothing usable — an inherited locale is the
  // user's own setting and must win. An empty value counts as absent, which is
  // what a GUI launch actually produces.
  if (platform === 'darwin' && !LOCALE_VARS.some((k) => env[k])) env.LC_CTYPE = 'UTF-8';

  return env;
}

// The values every terminal child is given so that programs draw as in a real
// terminal. Spread AFTER the base at each site, so they win over what the base
// holds.
//
// TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
// OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
// app's minimal Electron environment won't trigger those sequences.
const TERMINAL_IDENTITY_ENV = Object.freeze({
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'iTerm.app',
  TERM_PROGRAM_VERSION: '3.6.6',
  FORCE_COLOR: '3',
  ITERM_SESSION_ID: '1',
});

// Environment of the hidden `claude "/stats"` run (main.js, refresh-stats).
//
// Git Bash rewrites an argument that starts with a slash into a Windows path,
// so Claude was handed "C:/Program Files/Git/stats" as a prompt in place of
// the command /stats. MSYS2_ARG_CONV_EXCL exempts arguments that START with
// the listed prefixes: this adds /stats and nothing else. Not MSYS_NO_PATHCONV:
// this environment is inherited by the login shell's profile scripts, by
// Claude and by every hook it starts, and the wide switch would stop path
// conversion for all of them. A shell that is not MSYS ignores the variable.
function statsPtyEnv(baseEnv) {
  const held = baseEnv.MSYS2_ARG_CONV_EXCL;
  return {
    ...baseEnv,
    ...TERMINAL_IDENTITY_ENV,
    MSYS2_ARG_CONV_EXCL: typeof held === 'string' && held !== '' ? held + ';/stats' : '/stats',
  };
}

module.exports = { buildPtyEnv, CLAUDE_SESSION_VARS, TERMINAL_IDENTITY_ENV, statsPtyEnv };
