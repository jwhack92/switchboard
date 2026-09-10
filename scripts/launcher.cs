// Switchboard.exe — the icon you pin to the taskbar.
//
// Two jobs, both of which a shortcut alone gets wrong:
//
// 1. NO CONSOLE, EVER. Electron inherits whatever console its parent has, and
//    electron-log writes to it at debug level in dev builds. Launching from a
//    terminal therefore dumps Switchboard's log into that terminal — which
//    scrambles any full-screen TUI running there (Claude Code included).
//    /target:winexe plus CREATE_NO_WINDOW + a detached process group means the
//    child is never attached to a console at all.
//
// 2. Taskbar identity. Windows keys an app's taskbar button off its executable.
//    A shortcut straight to electron.exe pins as "Electron", with Electron's
//    icon, grouped with every other Electron app. This exe carries Switchboard's
//    own name and icon, and main.js calls app.setAppUserModelId with the same
//    id that electron-builder uses, so the pinned button and the running window
//    are one and the same.
//
// Built by scripts/build-launcher.ps1 with the C# compiler that ships in every
// Windows install — no toolchain to set up.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Switchboard")]
[assembly: AssemblyProduct("Switchboard")]
[assembly: AssemblyDescription("Browse, search and manage CLI coding sessions")]

static class SwitchboardLauncher
{
    const string Caption = "Switchboard";

    [STAThread]
    static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not start Switchboard.\n\n" + ex.Message,
                Caption, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static int Run(string[] args)
    {
        // scripts/Switchboard.exe → repo root is one level up.
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string repo = Path.GetFullPath(Path.Combine(exeDir, ".."));

        string electron = Path.Combine(repo, @"node_modules\electron\dist\electron.exe");
        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "Electron is not installed in this checkout.\n\nRun 'npm install' in:\n" + repo,
                Caption, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        if (!File.Exists(Path.Combine(repo, "main.js")))
        {
            MessageBox.Show("main.js not found in:\n" + repo, Caption,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // The renderer needs public/codemirror-bundle.js, which npm start builds.
        // Only build it when it is missing, so launching stays instant.
        string bundle = Path.Combine(repo, @"public\codemirror-bundle.js");
        if (!File.Exists(bundle)) RunBundler(repo);

        string argline = "\".\"";
        foreach (string a in args) argline += " " + Quote(a);

        // UseShellExecute = true is load-bearing, and the reason is subtle.
        //
        // The obvious way to keep Electron's output out of our console is to
        // redirect its stdio. That is WRONG here: redirecting creates pipes
        // owned by THIS process, and this process exits immediately after
        // spawning. The read ends close, and Electron's next write to stdout —
        // electron-log's console transport, which fires on any log.info — gets
        //     Error: EPIPE: broken pipe, write
        // as an uncaught exception in the main process, killing the app with a
        // modal error dialog. Draining with BeginOutputReadLine does not help:
        // those readers die with this process too.
        //
        // ShellExecute instead launches Electron the way Explorer does: it
        // inherits no console and no stdio handles from us at all, so there is
        // no pipe to break and nothing to leak into a terminal. This is exactly
        // the double-click-from-Explorer path, which is known good.
        // WindowStyle stays Normal. With UseShellExecute the style is passed to
        // the target as its initial SW_ command, so Hidden here does not
        // suppress a console (there is none) — it tells Electron to bring its
        // window up hidden, and you get a running app with nothing on screen.
        var psi = new ProcessStartInfo(electron, argline)
        {
            WorkingDirectory = repo,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Normal,
        };

        Process.Start(psi);
        return 0;
    }

    // Unlike the Electron spawn above, this one DOES redirect — and that is
    // safe because we wait for it to finish, so the pipes outlive the child.
    static void RunBundler(string repo)
    {
        string npm = FindOnPath("npm.cmd") ?? FindOnPath("npm.exe");
        if (npm == null) return;   // let Electron fail visibly instead
        var psi = new ProcessStartInfo(npm, "run bundle:codemirror")
        {
            WorkingDirectory = repo,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        try
        {
            var p = Process.Start(psi);
            p.StandardOutput.ReadToEnd();
            p.StandardError.ReadToEnd();
            p.WaitForExit(120000);
        }
        catch (Exception) { }
    }

    static string FindOnPath(string file)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            if (dir.Length == 0) continue;
            try
            {
                string full = Path.Combine(dir, file);
                if (File.Exists(full)) return full;
            }
            catch (Exception) { }
        }
        return null;
    }

    static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
}
