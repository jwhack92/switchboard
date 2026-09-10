<#
.SYNOPSIS
  Launch a fully ISOLATED second Switchboard instance (separate database).

.DESCRIPTION
  This is NOT how you get a second window any more. Switchboard supports real
  multi-window natively:

      Ctrl/Cmd+Shift+N          new window
      Ctrl/Cmd+Shift+O          tear the active session into its own window
      drag a session's handle   move it to another window, or out to a new one

  Those share one database, one index, one settings store, and one set of
  running sessions — which is what you want almost always.

  This script is for the other case: a genuinely separate instance with its own
  DB, for testing a change without touching your real session index.
  SWITCHBOARD_DATA_DIR isolates three things at once (main.js, db.js): the
  SQLite database, Electron's userData, and the single-instance lock.

  Caveat, and the reason this is not the multi-window answer: two instances read
  the same ~/.claude/projects but know nothing about each other. Resuming the
  SAME session in both starts two `claude` processes against one transcript.

.PARAMETER Instance
  Instance number. 1 is the normal install (~/.switchboard); 2, 3, ... get
  ~/.switchboard-2, ~/.switchboard-3, and so on.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\new-window.ps1 -Instance 2
#>
param(
    [int]$Instance = 2,
    [switch]$Bundle
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "electron not found - run 'npm install' first" }

if ($Bundle) {
    Push-Location $repo
    try { & npm run bundle:codemirror } finally { Pop-Location }
}

if ($Instance -le 1) {
    Write-Host "Instance 1 is the normal install - just start Switchboard."
    Write-Host "For extra WINDOWS (shared database), press Ctrl+Shift+N in the app."
    return
}

$dataDir = Join-Path $HOME ".switchboard-$Instance"
$env:SWITCHBOARD_DATA_DIR = $dataDir
Write-Host "isolated instance $Instance  ->  $dataDir"

Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $repo
Write-Host ""
Write-Host "This instance has its own database and its own session index." -ForegroundColor Yellow
Write-Host "Do NOT resume the same session here and in your main instance -" -ForegroundColor Yellow
Write-Host "that starts two claude processes against one transcript." -ForegroundColor Yellow
Write-Host ""
Write-Host "For multiple windows sharing one database, use Ctrl+Shift+N instead."
