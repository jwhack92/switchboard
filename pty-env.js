// Environment for PTY children.
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

function buildPtyEnv(sourceEnv) {
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

  // Only when the parent handed us nothing usable — an inherited locale is the
  // user's own setting and must win. An empty value counts as absent, which is
  // what a GUI launch actually produces.
  if (!LOCALE_VARS.some((k) => env[k])) env.LC_CTYPE = 'UTF-8';

  return env;
}

module.exports = { buildPtyEnv, CLAUDE_SESSION_VARS };
