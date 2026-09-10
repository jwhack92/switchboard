<#
.SYNOPSIS
  Build scripts\Switchboard.exe and put it on the Desktop and Start Menu.

.DESCRIPTION
  Switchboard.exe is the icon you pin to the taskbar. It starts Electron on this
  checkout with no console attached, so Switchboard's log can never bleed into a
  terminal (which scrambles any full-screen TUI running there).

  Compiled with the C# compiler that ships with the .NET Framework in every
  Windows install, so there is nothing to install first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1 -Uninstall
#>
param(
    [switch]$Uninstall,
    [switch]$NoDesktop,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo    = Split-Path -Parent $scripts
$exe     = Join-Path $scripts 'Switchboard.exe'
$src     = Join-Path $scripts 'launcher.cs'
$icon    = Join-Path $repo 'build\icon.ico'
$name    = 'Switchboard'

$targets = @( (Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk") )
if (-not $NoDesktop) {
    $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk")
}

if ($Uninstall) {
    foreach ($t in $targets) {
        if (Test-Path $t) { Remove-Item $t -Force; Write-Host "removed $t" }
    }
    Write-Host "(unpin from the taskbar by right-clicking the taskbar icon)"
    return
}

if (-not (Test-Path $icon)) { throw "icon not found: $icon" }

# --- compile -------------------------------------------------------------
$needsBuild = $Force -or -not (Test-Path $exe)
if (-not $needsBuild) {
    $t = (Get-Item $exe).LastWriteTime
    $needsBuild = ($t -lt (Get-Item $src).LastWriteTime) -or ($t -lt (Get-Item $icon).LastWriteTime)
}

if ($needsBuild) {
    $csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v*\csc.exe' -ErrorAction SilentlyContinue |
           Sort-Object FullName -Descending | Select-Object -First 1 -Expand FullName
    if (-not $csc) {
        $csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework\v*\csc.exe' -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1 -Expand FullName
    }
    if (-not $csc) { throw "no C# compiler found under C:\Windows\Microsoft.NET" }

    # /target:winexe → never allocates a console
    & $csc /nologo /target:winexe /optimize+ /win32icon:"$icon" `
           /r:System.Windows.Forms.dll /out:"$exe" "$src"
    if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }
    Write-Host "built $exe ($((Get-Item $exe).Length) bytes)"
} else {
    Write-Host "up to date: $exe"
}

# --- shortcuts -----------------------------------------------------------
$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
    $lnk = $shell.CreateShortcut($t)
    $lnk.TargetPath       = $exe
    $lnk.WorkingDirectory = $repo
    $lnk.IconLocation     = "$icon,0"
    $lnk.Description      = 'Browse, search and manage CLI coding sessions'
    $lnk.Save()
    Write-Host "created $t"
}

# --- taskbar identity ----------------------------------------------------
# A shortcut with no explicit AppUserModelID is identified by its target path,
# so a shortcut to Switchboard.exe and a window belonging to electron.exe look
# like two different apps to the taskbar. main.js sets the process side; this
# sets the shortcut side. Both must match or you get two buttons.
Write-Host ""
Write-Host "stamping taskbar identity..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $scripts 'set-aumid.ps1')

Write-Host ""
Write-Host "To pin: right-click  $exe  -> Pin to taskbar"
Write-Host "        (Windows 11 may hide it behind 'Show more options')"
Write-Host ""
Write-Host "It launches this checkout, so your edits are live - no rebuild needed."
