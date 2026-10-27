'use strict';
// pty-close.js: closes a session's terminal without freezing the app.
//
// On Windows ConPTY (useConptyDll off, the default here) node-pty 1.1.0's
// kill() asks its agent for the console's process list, and that runs a
// synchronous child_process.fork() of conpty_console_list_agent: 1.0-1.6 s of
// a frozen main thread per terminal, 21 s at a 14-session quit on 2026-10-27
// (tools/docs switchboard-app-behaviour.md, "Relaunch versus quit in the log").
// The forked agent then always fails ("AttachConsole failed": kill() closes
// the console right after the fork), so node-pty already falls back, after its
// 5 s timeout, to force-ending the shell pid alone.
//
// closePty gives node-pty that same answer without the fork: the shell pid,
// after 5 s. Everything else is node-pty's own kill(). The replaced method and
// the call to it are node-pty's private names; test/pty-close.test.js checks
// them in the installed node-pty, which package.json pins to exactly 1.1.0.
//
// Pure: no Electron, no other module, no side effect on load.

/** How long after the close the shell pid is force-ended, as node-pty's own timeout does. */
const FORCE_END_MS = 5000;

/**
 * closePty(ptyProcess, { setTimer, platform })
 *   Kills the terminal through node-pty's kill(). On win32 ConPTY without the
 *   DLL, the agent's console-list fork is replaced first. A throw from kill()
 *   comes out unchanged.
 */
function closePty(ptyProcess, { setTimer = setTimeout, platform = process.platform } = {}) {
  const agent = ptyProcess && ptyProcess._agent;
  if (platform === 'win32' && agent && agent._useConpty === true && agent._useConptyDll !== true
      && typeof agent._getConsoleProcessList === 'function') {
    agent._getConsoleProcessList = () => new Promise((resolve) => {
      // unref: a quit must not wait for it, as it never waited for the fork's timeout either.
      const timer = setTimer(() => resolve([agent._innerPid]), FORCE_END_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }
  ptyProcess.kill();
}

module.exports = { closePty, FORCE_END_MS };
