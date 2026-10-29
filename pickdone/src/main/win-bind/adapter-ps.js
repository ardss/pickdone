/** T7 win-bind adapter — the PowerShell/C# side of the resident probe process.
 *
 *  Field-probing (task ask) established the hard constraints baked in here:
 *   - WindowFromPoint returns the INNERMOST child window → GetAncestor(GA_ROOT) is mandatory;
 *   - PowerShell ScriptBlocks CANNOT be passed as EnumWindows callback args
 *     (MethodArgumentConversionInvalidCast) → the whole enumeration runs inside a C# delegate;
 *   - powershell.exe -NoProfile cold start ≈1.7-1.8s + Add-Type ≈0.7s → resident child is the
 *     only acceptable shape (one-shot would cost ~2.5s per query);
 *   - koffi/ffi is excluded (new npm dependency; package.json is a dirty-file no-go).
 *
 *  Wire protocol (one JSON object per line, auto-incremented ids echoed back):
 *    request : {"id":1,"op":"ping"} | {"id":2,"op":"probe"} | {"id":3,"op":"enum"}
 *              | {"id":4,"op":"activate","hwnd":723854}
 *    response: {"id":1,"ok":true,"result":...} | {"id":1,"ok":false,"error":"..."}
 *  All responses are written by [Console]::Out.WriteLine (no ScriptBlock callbacks); the boot
 *  "pong" doubles as the compile-done barrier — Add-Type runs before the loop starts, so the
 *  first acknowledged query is already hot.
 *
 *  Quoting discipline (the reason this file looks unusual): the C# source travels inside a JS
 *  template literal. To keep every layer auditable, the C# side avoids backslash escapes in
 *  JSON string literals entirely — placeholders 'X' are swapped for the DQ char literal ('"'
 *  needs no escaping inside C# single quotes), and the ONLY backslashes left in C# are the four
 *  char literals '\\' '\n' '\r' '\t'. The PowerShell side uses single-quoted literal strings,
 *  which need no quote escaping at all. Physical pixel coordinates NEVER leave this process
 *  (the renderer passes zero args to winBindIdentify — frozen contract). */
'use strict'

const CSHARP_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WinBind {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool FlashWindow(IntPtr hWnd, bool bInvert);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    const uint GA_ROOT = 2;
    const int SW_RESTORE = 9;
    const int VK_LBUTTON = 0x01;
    const byte VK_MENU = 0x12;
    const uint KEYEVENTF_KEYUP = 0x2;
    const int TITLE_CAP = 512;
    const char DQ = '"';
    const char BS = '\\\\';
    const char NL = '\\n';
    const char CR = '\\r';
    const char TB = '\\t';

    static string JsonStr (string s) {
      if (s == null) s = "";
      StringBuilder sb = new StringBuilder(s.Length + 8);
      foreach (char c in s) {
        if (c == DQ || c == BS) { sb.Append(BS); sb.Append(c); }
        else if (c == NL) sb.Append(BS).Append('n');
        else if (c == CR) sb.Append(BS).Append('r');
        else if (c == TB) sb.Append(BS).Append('t');
        else if (c < ' ') sb.Append(BS).Append('u').Append(((int)c).ToString("x4"));
        else sb.Append(c);
      }
      return DQ + sb.ToString() + DQ;
    }

    static string TitleOf (IntPtr h) {
      StringBuilder sb = new StringBuilder(TITLE_CAP + 1);
      int n = GetWindowTextW(h, sb, TITLE_CAP + 1);
      return n > 0 ? sb.ToString(0, Math.Min(n, TITLE_CAP)) : "";
    }

    public static string PingJson () { return "{XokX:true,XresultX:XpongX}".Replace('X', DQ); }

    public static string ProbeJson () {
      try {
        POINT pt;
        if (!GetCursorPos(out pt)) return "{XokX:true,XresultX:{XrawX:null,XbuttonDownX:null}}".Replace('X', DQ);
        IntPtr child = WindowFromPoint(pt);
        IntPtr root = child == IntPtr.Zero ? IntPtr.Zero : GetAncestor(child, GA_ROOT);
        if (root == IntPtr.Zero) return "{XokX:true,XresultX:{XrawX:null,XbuttonDownX:false}}".Replace('X', DQ);
        uint pid;
        GetWindowThreadProcessId(root, out pid);
        bool down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        string head = ("{XhwndX:" + root.ToInt64() + ",XpidX:" + pid + ",XtitleX:").Replace('X', DQ);
        string json = head + JsonStr(TitleOf(root)) + ",XbuttonDownX:".Replace('X', DQ) + (down ? "true" : "false");
        return "{XokX:true,XresultX:".Replace('X', DQ) + json + "}}";
      } catch (Exception e) {
        return "{XokX:false,XerrorX:".Replace('X', DQ) + JsonStr(e.Message) + "}";
      }
    }

    public static string EnumJson () {
      try {
        List<string> rows = new List<string>();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
          if (!IsWindowVisible(h)) return true;
          uint pid;
          GetWindowThreadProcessId(h, out pid);
          if (pid == 0) return true;
          rows.Add(("{XhwndX:" + h.ToInt64() + ",XpidX:" + pid + ",XtitleX:").Replace('X', DQ) + JsonStr(TitleOf(h)) + "}");
          return true;
        }, IntPtr.Zero);
        StringBuilder sb = new StringBuilder();
        sb.Append("{XokX:true,XresultX:[".Replace('X', DQ));
        for (int i = 0; i < rows.Count; i++) { if (i > 0) sb.Append(','); sb.Append(rows[i]); }
        sb.Append("]}");
        return sb.ToString();
      } catch (Exception e) {
        return "{XokX:false,XerrorX:".Replace('X', DQ) + JsonStr(e.Message) + "}";
      }
    }

    public static string ActivateJson (long hwnd64) {
      try {
        IntPtr h = new IntPtr(hwnd64);
        bool wasIconic = IsIconic(h);
        bool set = false;
        bool fgNow = false;
        int attempts = 0;
        // [QA r1 #2/#5] plain SetForegroundWindow is DENIED for a background process without
        // OS foreground rights (the resident PS child never received input), and it can race
        // SW_RESTORE's async completion on minimized windows. Bounded escalation: every attempt
        // first lets a pending restore finish (poll IsIconic), then tries the switch — attempt 1
        // plain, attempts 2+ attach into the CURRENT foreground thread's input queue and spoof a
        // single ALT press (classic idiom that satisfies the foreground lock). FlashWindow stays
        // the final degrade; worst case ~0.9s, far under the adapter's 5s query timeout.
        while (!fgNow && attempts < 3) {
          attempts++;
          if (IsIconic(h)) {
            ShowWindow(h, SW_RESTORE);
            for (int i = 0; i < 25 && IsIconic(h); i++) Thread.Sleep(10);
          }
          if (attempts == 1) {
            set = SetForegroundWindow(h);
          } else {
            IntPtr fg = GetForegroundWindow();
            uint fgPid;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            uint myThread = GetCurrentThreadId();
            bool attached = false;
            bool altDown = false;
            try {
              attached = fgThread != 0 && fgThread != myThread && AttachThreadInput(myThread, fgThread, true);
              altDown = true;
              keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
              set = SetForegroundWindow(h);
            } finally {
              try {
                if (altDown) keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
              } finally {
                if (attached) {
                  if (!AttachThreadInput(myThread, fgThread, false)) {
                    throw new InvalidOperationException("AttachThreadInput detach failed");
                  }
                }
              }
            }
          }
          fgNow = GetForegroundWindow() == h;
          if (!fgNow) Thread.Sleep(30);
        }
        bool flashed = false;
        if (!fgNow) flashed = FlashWindow(h, true);
        return ("{XokX:true,XresultX:{XwasIconicX:" + (wasIconic ? "true" : "false")
          + ",XsetForegroundX:" + (set ? "true" : "false")
          + ",XforegroundNowX:" + (fgNow ? "true" : "false")
          + ",XflashedX:" + (flashed ? "true" : "false")
          + ",XattemptsX:" + attempts + "}}").Replace('X', DQ);
      } catch (Exception e) {
        return "{XokX:false,XerrorX:".Replace('X', DQ) + JsonStr(e.Message) + "}";
      }
    }
  }
}
`

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -TypeDefinition @'
__CSHARP__
'@

function Resolve-Proc ([int]$procId) {
  $pn = ''; $exe = ''
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $pn = [string]$p.ProcessName
    try { $exe = [string]$p.MainModule.FileName } catch { $exe = '' }
  } catch {}
  return @{ pn = $pn; exe = $exe }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    $op = [string]$req.op
    switch ($op) {
      'ping' {
        $r = [WinBind.Native]::PingJson()
      }
      'probe' {
        $res = ([WinBind.Native]::ProbeJson() | ConvertFrom-Json).result
        if ($res.hwnd -gt 0) {
          $proc = Resolve-Proc ([int]$res.pid)
          $raw = [pscustomobject]@{ hwnd = [int64]$res.hwnd; pid = [int]$res.pid; processName = $proc.pn; execPath = $proc.exe; title = [string]$res.title }
          $bd = 'false'; if ([bool]$res.buttonDown) { $bd = 'true' }
          $r = '{"ok":true,"result":{"raw":' + (ConvertTo-Json -InputObject $raw -Compress -Depth 4) + ',"buttonDown":' + $bd + '}}'
        } else {
          $bd = 'false'; if ($null -ne $res.buttonDown -and [bool]$res.buttonDown) { $bd = 'true' }
          $r = '{"ok":true,"result":{"raw":null,"buttonDown":' + $bd + '}}'
        }
      }
      'enum' {
        $wins = ([WinBind.Native]::EnumJson() | ConvertFrom-Json).result
        $out = @()
        if ($wins) {
          foreach ($w in $wins) {
            $proc = Resolve-Proc ([int]$w.pid)
            $out += [pscustomobject]@{ hwnd = [int64]$w.hwnd; pid = [int]$w.pid; processName = $proc.pn; execPath = $proc.exe; title = [string]$w.title }
          }
        }
        if ($out.Count -eq 0) { $r = '{"ok":true,"result":[]}' }
        else { $r = '{"ok":true,"result":' + (ConvertTo-Json -InputObject $out -Compress -Depth 4) + '}' }
      }
      'activate' {
        $r = [WinBind.Native]::ActivateJson([int64]$req.hwnd)
      }
      default { $r = '{"ok":false,"error":"unknown op"}' }
    }
  } catch {
    $msg = [string]$_.Exception.Message -replace '[\\\\"]', ' '
    $r = '{"ok":false,"error":"' + $msg + '"}'
  }
  $body = [string]$r
  if ($body.StartsWith('{') -and $body.EndsWith('}')) { $body = $body.Substring(1, $body.Length - 2) }
  [Console]::Out.WriteLine('{"id":' + $id + ',' + $body + '}')
}
`

/** Build the spawn argv for the resident probe process. The script travels base64
 *  (UTF-16LE, -EncodedCommand) so no quoting layer can mangle the embedded C# source. */
function buildPsCommand (powershellPath) {
  const script = PS_SCRIPT.replace('__CSHARP__', CSHARP_SOURCE)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return {
    cmd: powershellPath || 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
  }
}

module.exports = { buildPsCommand, PS_SCRIPT, CSHARP_SOURCE }
