<#
.SYNOPSIS
  Stamp an AppUserModelID onto Windows shortcuts.

.DESCRIPTION
  Windows gives a running window and a pinned shortcut the same taskbar button
  only when both carry the same AppUserModelID.

  main.js calls app.setAppUserModelId('ai.doctly.switchboard'), which covers the
  process side. This covers the other half: without an explicit AUMID a shortcut
  is identified by its target path, so a shortcut to Switchboard.exe and a window
  belonging to electron.exe look like two different apps — hence two buttons, and
  hence pinning the running window pins a generic "Electron".

  Every properly installed Electron app does this. Obsidian's pinned shortcut
  carries md.obsidian; Chrome's carries Chrome.

  Reading and writing this property is COM (IShellLink + IPropertyStore), so the
  work is done by a small inline C# type. Two things that will waste an hour if
  you touch it: PROPVARIANT is 24 bytes on x64, not 16 — declaring it short lets
  GetValue write past the struct — and InitPropVariantFromString is an inline SDK
  helper, NOT a real propsys.dll export, so a VT_LPWSTR variant has to be built
  by hand.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\set-aumid.ps1
  powershell -ExecutionPolicy Bypass -File scripts\set-aumid.ps1 -Report
#>
param(
    [string]$AppId = 'ai.doctly.switchboard',
    [switch]$Report
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Aumid
{
    static readonly PropertyKey PKEY_AppUserModel_ID =
        new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    const ushort VT_LPWSTR = 31;

    public static string Get(string lnkPath)
    {
        object o = new ShellLink();
        try
        {
            ((IPersistFile)o).Load(lnkPath, 0);
            var store = (IPropertyStore)o;
            PropVariant pv;
            PropertyKey key = PKEY_AppUserModel_ID;
            store.GetValue(ref key, out pv);
            try
            {
                if (pv.vt != VT_LPWSTR || pv.p == IntPtr.Zero) return null;
                return Marshal.PtrToStringUni(pv.p);
            }
            finally { PropVariantClear(ref pv); }
        }
        catch (Exception) { return null; }
        finally { Marshal.ReleaseComObject(o); }
    }

    public static void Set(string lnkPath, string appId)
    {
        object o = new ShellLink();
        try
        {
            ((IPersistFile)o).Load(lnkPath, 2 /* STGM_READWRITE */);
            var store = (IPropertyStore)o;

            var pv = new PropVariant();
            pv.vt = VT_LPWSTR;
            pv.p = Marshal.StringToCoTaskMemUni(appId);
            try
            {
                PropertyKey key = PKEY_AppUserModel_ID;
                store.SetValue(ref key, ref pv);
                store.Commit();
            }
            finally { PropVariantClear(ref pv); }

            ((IPersistFile)o).Save(lnkPath, true);
        }
        finally { Marshal.ReleaseComObject(o); }

        // Nudge Explorer so it re-reads the shortcut.
        SHChangeNotify(0x00002000 /* SHCNE_UPDATEITEM */, 0x0005 /* SHCNF_PATHW */,
                       Marshal.StringToHGlobalUni(lnkPath), IntPtr.Zero);
    }

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);
    [DllImport("shell32.dll")]
    static extern void SHChangeNotify(uint eventId, uint flags, IntPtr a, IntPtr b);

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        Guid fmtid; uint pid;
        public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; }
    }

    // 24 bytes on x64: VARTYPE + 3 reserved words, then a union wide enough for
    // the largest member. Declaring 16 lets GetValue scribble past the end.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr p;
        [FieldOffset(16)] public IntPtr p2;
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string file,
                  [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        void GetCount(out uint c);
        void GetAt(uint i, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }
}
'@ -ErrorAction Stop

$name = 'Switchboard'
$paths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk")
)

# Whatever Windows copied into the taskbar when the user pinned it. Match on the
# link's own file name, because the pinned copy may target either the launcher
# exe or electron.exe depending on how it was pinned.
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (Test-Path $pinned) {
    $paths += (Get-ChildItem $pinned -Filter '*.lnk' |
               Where-Object { $_.BaseName -like "*$name*" -or $_.BaseName -like '*lectron*' } |
               Select-Object -Expand FullName)
}

foreach ($p in ($paths | Select-Object -Unique)) {
    if (-not (Test-Path $p)) { Write-Host "  (missing)  $p"; continue }
    $current = [Aumid]::Get($p)
    if ($Report) {
        Write-Host ("  {0,-22} {1}" -f ($(if ($current) { $current } else { '(not set)' })), $p)
        continue
    }
    if ($current -eq $AppId) {
        Write-Host "  already set   $p"
    } else {
        [Aumid]::Set($p, $AppId)
        $after = [Aumid]::Get($p)
        Write-Host ("  {0}  $p" -f $(if ($after -eq $AppId) { 'stamped     ' } else { 'FAILED      ' }))
    }
}

if (-not $Report) {
    Write-Host ""
    Write-Host "AppUserModelID: $AppId"
    Write-Host "If the taskbar still shows two buttons, unpin and re-pin once -"
    Write-Host "Windows caches the identity of a pinned item."
}
