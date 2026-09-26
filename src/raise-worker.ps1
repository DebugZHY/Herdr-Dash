# src/raise-worker.ps1 — CONTRACT-v2 §13.9 (round 9.8) and §13.10 (round 9.9, owner W1)
#
# The warm half of §13.6. Round 9.6 raised the opened window from a process started
# PER CLICK, which measured 141-213 ms of PowerShell startup before any work, plus its
# bounded waits — and all of it sat in front of the HTTP response. Measured then:
# `POST /api/open` answered in 709-720 ms while the actual OS hand-off,
# `spawn('explorer.exe',[path])`, costs 3-6 ms. §13.9 corrected the budget: the click
# must answer in ≤ 50 ms warm, and the raise is now issued AFTER the response, so this
# worker must start NO process per click.
#
# So: ONE long-lived process holding the window APIs (the Add-Type below is paid once),
# driven by line-JSON on stdin, answering on stdout. The click writes two short lines —
# `arm` before the hand-off, `raise` after the response — and never waits for either.
#
# PROTOCOL (one JSON object per line on stdin; one `@HD-...@` line per event on stdout)
#
#   in  {"cmd":"arm","id":"<id>"}                      snapshot NOW, keep it for <id>
#   in  {"cmd":"raise","id":"<id>","target":"C:\\x","kind":"dir|file","wait_ms":350}
#   in  {"cmd":"raise",...,"no_diff":true}             §13.10: nothing was spawned, so
#                                                      nothing new is expected — find an
#                                                      existing window for `target` only
#   in  {"cmd":"probe","id":"p1","hwnd":123}           is that window still there?
#   in  {"cmd":"quit"}
#   out @HD-WORKER-READY@ {}                           the APIs are loaded
#   out @HD-RAISE@ {"id":..,"raised":..,"vis":..,"how":..,"hwnd":..,"t":..,"mode":..}
#   out @HD-PROBE@ {"id":"p1","alive":true,"folder":true}
#
# §13.10 (`probe`): the server remembers "path -> the HWND a hand-off produced" so a
# second click on the same folder raises that window instead of piling up another one.
# A memory can be stale — the user closes windows — and §13.10 item 4 forbids a stale
# entry turning into a click that quietly does nothing. What makes the entry stale is
# only knowable from Win32, so the server asks, and this answers: `IsWindow` and
# `GetClassName` on ONE remembered handle, both LOCAL calls on this side (no COM, no
# enumeration, nothing that can block on Explorer), which is why a probe can be answered
# in about a millisecond and still be a measurement rather than a guess. A probe is
# never taken for proof on its own: the `no_diff` job below re-checks the window's exact
# shell location before it touches anything.
#
# §13.10 (`no_diff`): a job for a folder that was NOT spawned by this click. The diff
# cannot be used — every window that appeared since the snapshot is somebody else's, and
# raising one would be exactly the unrelated-window grab §13.6 item 4 forbids. So this
# skips phase (1) entirely and goes straight to the exact-location rule, retrying until
# `wait_ms` is spent: a hand-off issued moments ago may not have produced its window yet.
#
# WHY `arm` EXISTS. A diff can only say what THIS click caused if its snapshot predates
# the hand-off. The worker cannot take that snapshot when the `raise` job arrives (the
# window may already exist by then), so the caller sends `arm` BEFORE spawning and
# `raise` after answering. Both are pipe writes of ~40 bytes: nothing is awaited, so
# neither is on the click's critical path.
#
# WHEN THERE IS NO `arm` SNAPSHOT (a click that raced a previous job, a worker that
# started mid-flight) THE DIFF IS NOT USED AT ALL. Without a "before" every window on
# the desktop is "new", and raising from that set would be exactly the unrelated-window
# grab §13.6 item 4 forbids. The exact-location path is the only one left, and it is
# safe on its own: it may only touch a window whose shell location IS the path asked for.
#
# SAFETY (§13.6 item 4, unchanged): only a window from the HWND diff, or one whose shell
# location is EXACTLY the requested path, is ever touched. Never the foreground window,
# never a retry loop, nothing at all on a failure. Exit code 0 for every completed job.
#
# HONESTY (§13.2.7/§13.9): this process measures, and the server LOGS what it says. The
# synchronous answer never claims a raise — it cannot, the raise has not happened yet —
# and `raised` is true only when the window was confirmed on screen AND in front.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class HdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public const int SW_SHOW = 5;
  public const int SW_RESTORE = 9;
  public const byte VK_MENU = 0x12;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  /// Every top-level window, visible or not: the diff must be able to see a window that
  /// exists but has not been shown, which is a measured normal case here.
  public static List<IntPtr> Snapshot() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }

  public static string ClassName(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }

  /// The process that owns a window. Reported in every result so the log can answer the
  /// question a duplicate window raises — "is that another Explorer process, or the same
  /// one?" (measured here: one process per folder window on Windows 11, and the process
  /// OUTLIVES its window, which is why a remembered pid is not a liveness test).
  public static uint Pid(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  /// Is this a folder window — the only kind of window a folder path can have been
  /// handed to? This costs one local call, and it exists to avoid the one that is not
  /// local: reading `LocationURL` goes across processes into Explorer, and a shell with
  /// 61 windows of which ~15 are folder windows was paying for all 61 (measured).
  public static bool IsFolderWindow(IntPtr h) {
    var c = ClassName(h);
    return c == "CabinetWClass" || c == "ExploreWClass";
  }

  public static string Rect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }

  /// Could a person see something in this window? A title, and a rectangle with room in
  /// it. This is what separates a real result from the "Default IME" / "MSCTFIME UI" /
  /// "DesktopWindowXamlSource" husks every Explorer spawn trails behind it.
  public static bool Plausible(IntPtr h) {
    if (Title(h).Length == 0) return false;
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    return (r.Right - r.Left) >= 100 && (r.Bottom - r.Top) >= 100;
  }

  /// Show if hidden, restore if minimized, then raise — with the documented Alt-tap
  /// fallback — and CONFIRM the result rather than assume it. True only when the target
  /// really ends up both visible and in front.
  ///
  /// The confirmation is not belt-and-braces: ShowWindow on another process's window is
  /// POSTED, not applied, so an immediate check reads stale. Measured on this machine —
  /// same script, same folder, only the spawn options differing — `vis_after_show=False`
  /// and `vis_300ms_later=True` when the caller hides its own console. Believing the
  /// immediate reading is how the first version of this raise reported success on a
  /// window the user still could not see.
  public static bool Raise(IntPtr h) {
    ShowAndFront(h);
    if (Settle(h, 300)) return true;
    // One bounded re-assert for the asynchronous case above, then the truth. §13.6
    // item 4's "never a retry loop" is why there is no third.
    ShowAndFront(h);
    return Settle(h, 400);
  }

  /// Wait for the window to actually BE visible and in front — the state callers are
  /// told about — giving an asynchronous apply a chance to land. Bounded, and it only
  /// observes: every assertion in this class happens outside this loop.
  static bool Settle(IntPtr h, int ms) {
    var deadline = DateTime.UtcNow.AddMilliseconds(ms);
    while (true) {
      if (IsWindowVisible(h) && GetForegroundWindow() == h) return true;
      if (DateTime.UtcNow >= deadline) return false;
      System.Threading.Thread.Sleep(40);
    }
  }

  static void ShowAndFront(IntPtr h) {
    if (!IsWindowVisible(h)) ShowWindow(h, SW_SHOW);
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return;

    // The foreground lock refused. The fallback §13.6 item 1 allows: tap Alt so this
    // process looks like it just received input, and attach our input to the foreground
    // thread, which is what the lock actually checks.
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = AttachThreadInput(me, fgThread, true);
    try {
      keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      BringWindowToTop(h);
      SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }
}
'@

# ── the exact-location rule, shared by the reuse path ────────────────────────
# A shell LocationURL is a percent-encoded file:// URL; the requested path is a native
# Win32 path. Both are reduced to one comparable spelling: decoded, forward slashes,
# no trailing separator, case-folded (Windows paths are case-insensitive).
function Get-NormPath([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  $t = $s
  if ($t -match '^(?i)file:///') { $t = $t.Substring(8) }
  try { $t = [uri]::UnescapeDataString($t) } catch { }
  return $t.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
}

# `Shell.Application` is created ONCE, at startup, and deliberately not lazily. It is the
# reuse path's only tool, and on this machine the first `Windows()` call behind it measured
# ~3 s — which, created lazily, landed inside the first job that needed it: a raise that
# took 4089 ms against the ~1 s everything here is bounded to. Warming it before READY puts
# that cost behind the `/api/pathinfo` that starts the worker (§13.9), where no click waits.
$script:shell = $null
function Get-ShellWindows {
  if ($null -eq $script:shell) { $script:shell = New-Object -ComObject Shell.Application }
  return $script:shell.Windows()
}

$armed = @{}                      # id -> List<IntPtr> taken before that click's hand-off
$armedOrder = New-Object System.Collections.ArrayList

function Get-Before([string]$id) {
  if (-not $armed.ContainsKey($id)) { return $null }
  $snap = $armed[$id]
  $armed.Remove($id)
  [void]$armedOrder.Remove($id)
  return $snap
}

function Invoke-RaiseJob($job) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $id = [string]$job.id
  $target = [string]$job.target
  $kind = if ([string]$job.kind -eq 'file') { 'file' } else { 'dir' }
  $waitMs = if ($job.wait_ms) { [int]$job.wait_ms } else { 350 }
  # §13.10: this click handed nothing over, so there is no new window to diff against and
  # the only window this job may touch is one whose shell location IS the requested path.
  $noDiff = ($job.no_diff -eq $true)
  # The picked window's owner, reported so the log can tell a second process from a second
  # window of the same one.
  $pickPid = 0
  $mode = if ($noDiff) { 'reuse' } else { 'diff' }
  # The same for the shell scan, which is the only phase whose cost is another process's
  # to decide. Measured here: `Shell.Application.Windows()` is 3-28 ms on a settled shell
  # and spiked to 334 ms when a newly spawned Explorer process joined it — but in the
  # worker it has twice blocked for 1700-2915 ms when it ran ~350 ms after a spawn, which
  # is exactly when the reuse path runs. 1200 ms cut the scan off before its first window
  # (`shells:0, cut:true`) and the click's existing window went unraised. Nothing waits for
  # this phase, so the bound is set where the measurement says the stall ends.
  $shellMs = if ($job.shell_ms) { [int]$job.shell_ms } else { 2000 }
  $wantNorm = Get-NormPath $target

  $snapBefore = Get-Before $id
  $before = @{}
  if ($null -ne $snapBefore) { foreach ($h in $snapBefore) { $before[$h.ToInt64()] = $true } }

  $fresh = @()
  $how = 'none'
  $touched = @()
  $raisedTo = 0
  # Phase marks. Every bound in this function is meant to be small, so a job that takes
  # seconds has to say WHERE it spent them — the alternative is guessing, and the first
  # version of this file guessed wrong about its own 4-second job.
  $tDiff = 0
  $tShell = 0
  $tRaise = 0
  $cut = $false
  $shellSeen = 0

  # ── (1) the diff — ONLY when a pre-hand-off snapshot exists (see the header) ──
  if ($null -ne $snapBefore -and -not $noDiff) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
    while ($true) {
      $fresh = @()
      foreach ($h in [HdWin]::Snapshot()) {
        if ($before.ContainsKey($h.ToInt64())) { continue }
        # A new top-level HWND is not yet a result: the "Default IME" husks arrive first.
        if (-not [HdWin]::Plausible($h)) { continue }
        $fresh += $h
      }
      if ($fresh.Count -gt 0) { break }
      if ([DateTime]::UtcNow -ge $deadline) { break }
      Start-Sleep -Milliseconds 40
    }
  }
  $tDiff = $sw.ElapsedMilliseconds

  if ($fresh.Count -gt 0) {
    $how = 'diff'
    # Visible windows first: if the spawn produced something already on screen, that is
    # the result, and a hidden husk of the same spawn must not displace it.
    $ordered = @($fresh | Where-Object { [HdWin]::IsWindowVisible($_) }) + @($fresh | Where-Object { -not [HdWin]::IsWindowVisible($_) })
    $raiseDeadline = [DateTime]::UtcNow.AddMilliseconds(800)
    foreach ($h in ($ordered | Select-Object -First 8)) {
      if ($raisedTo -ne 0) { break }
      if ([DateTime]::UtcNow -ge $raiseDeadline) { break }
      # §13.6 item 4: the foreground window is never MODIFIED. If a window this click
      # caused is already in front, the user already has it — but being in front is not
      # the same as being on screen (a HIDDEN window can hold the foreground, which is
      # the very state this exists to fix), so it counts only if a person can see it.
      if ($h.ToInt64() -eq ([HdWin]::GetForegroundWindow()).ToInt64()) {
        if ([HdWin]::IsWindowVisible($h)) { $raisedTo = $h.ToInt64(); $pickPid = [HdWin]::Pid($h) }
        continue
      }
      $touched += ($h.ToInt64())
      if ([HdWin]::Raise($h)) { $raisedTo = $h.ToInt64(); $pickPid = [HdWin]::Pid($h) }
    }
  }
  $tRaise = $sw.ElapsedMilliseconds

  # ── (2) the exact-location path: no new window, so find the existing one by location ──
  if ($raisedTo -eq 0 -and $kind -eq 'dir' -and -not [string]::IsNullOrEmpty($wantNorm)) {
    # A `no_diff` job has nothing to wait for in phase (1), but it may be about a hand-off
    # issued moments ago whose window has not appeared yet (§13.10's "pending" click, the
    # second of two clicks in the same second). Waiting is the difference between raising
    # that window and reporting `how:"none"` for a folder that exists — so this retries the
    # scan until `wait_ms` is spent, and only then says it found nothing.
    $retryDeadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
    while ($true) {
    $matches = @()
    # This phase reads properties of windows that belong to OTHER processes, and one of
    # them can be slow to answer — measured on this machine: 102 ms for a settled shell,
    # and 2915 ms in the job that ran while a freshly spawned Explorer process was still
    # coming up. §13.9 keeps the raise off the click's path, so that is a cost no user
    # pays; but it is not allowed to be unbounded either, so the scan stops at a deadline
    # and SAYS it was cut short rather than reporting a clean "none".
    $reuseDeadline = [DateTime]::UtcNow.AddMilliseconds($shellMs)
    try {
      foreach ($w in (Get-ShellWindows)) {
        if ([DateTime]::UtcNow -ge $reuseDeadline) { $cut = $true; break }
        $shellSeen += 1
        $h = [IntPtr][int64]$w.HWND
        if ($h.ToInt64() -eq 0) { continue }
        if (-not [HdWin]::IsWindow($h)) { continue }
        # Local, cheap, and it is also the safety rule: a folder path can only have been
        # handed to a folder window, so nothing else is ever read or touched.
        if (-not [HdWin]::IsFolderWindow($h)) { continue }
        if ((Get-NormPath ([string]$w.LocationURL)) -ne $wantNorm) { continue }
        $matches += $h
      }
    } catch {
      $matches = @()
    }
    $tShell = $sw.ElapsedMilliseconds
    # A visible one is the window the user means. Only if there is none is a window that
    # already existed before this click considered — never one this spawn created (the
    # diff above would have had it) and never a parked husk of another folder. Newest
    # first, because Explorer's newest window is the one it last used.
    $visible = @($matches | Where-Object { [HdWin]::IsWindowVisible($_) })
    $preExisting = @($matches | Where-Object { $before.ContainsKey($_.ToInt64()) -and -not [HdWin]::IsWindowVisible($_) })
    $pick = @()
    if ($visible.Count -gt 0) { $pick = $visible | Sort-Object { $_.ToInt64() } -Descending }
    elseif ($preExisting.Count -gt 0) { $pick = $preExisting | Sort-Object { $_.ToInt64() } -Descending }
    foreach ($h in ($pick | Select-Object -First 1)) {
      $how = 'reuse'
      if ($h.ToInt64() -eq ([HdWin]::GetForegroundWindow()).ToInt64()) {
        if ([HdWin]::IsWindowVisible($h)) { $raisedTo = $h.ToInt64(); $pickPid = [HdWin]::Pid($h) }
        continue
      }
      # Raise() is the one call here that can block on ANOTHER process: it attaches its
      # input to whatever window currently holds the foreground (the Alt-tap fallback).
      # Only a window this job already picked is ever passed to it.
      $touched += ($h.ToInt64())
      if ([HdWin]::Raise($h)) { $raisedTo = $h.ToInt64(); $pickPid = [HdWin]::Pid($h) }
    }
    if ($tRaise -eq 0) { $tRaise = $sw.ElapsedMilliseconds }
    if ($raisedTo -ne 0) { break }
    if (-not $noDiff) { break }
    if ([DateTime]::UtcNow -ge $retryDeadline) { break }
    Start-Sleep -Milliseconds 60
    }
  }

  return '{"id":' + (ConvertTo-Json $id -Compress) +
    ',"raised":' + $(if ($raisedTo -ne 0) { 'true' } else { 'false' }) +
    ',"vis":' + $(if ($raisedTo -ne 0 -and [HdWin]::IsWindowVisible([IntPtr][int64]$raisedTo)) { 'true' } else { 'false' }) +
    ',"how":"' + $how + '"' +
    ',"hwnd":' + $raisedTo +
    ',"pid":' + $pickPid +
    ',"mode":"' + $mode + '"' +
    # The exact string the caller asked about, echoed back: it is what lets the caller keep
    # a memory keyed on ITS OWN spelling of the path rather than on this file's reduction
    # of it, so the two can never disagree about which folder a remembered window is for.
    ',"t":' + (ConvertTo-Json $target -Compress) +
    ',"tn":' + (ConvertTo-Json $wantNorm -Compress) +
    ',"armed":' + $(if ($null -ne $snapBefore) { 'true' } else { 'false' }) +
    ',"touch":[' + (($touched | Sort-Object) -join ',') + ']' +
    ',"t_diff":' + $tDiff +
    ',"t_shell":' + $tShell +
    ',"t_raise":' + $tRaise +
    ',"cut":' + $(if ($cut) { 'true' } else { 'false' }) +
    ',"shells":' + $shellSeen +
    ',"ms":' + $sw.ElapsedMilliseconds +
    '}'
}

# ── the loop ────────────────────────────────────────────────────────────────
# One job at a time. A raise is bounded to well under two seconds and a click that
# arrives during one gets its `arm` processed late — which costs it the diff, never the
# raise: the exact-location path needs no snapshot, so the window is still found.
#
# Everything expensive happens BEFORE this line, so READY means "a job will be served
# fast" rather than "the process is alive": Add-Type above, and here the shell COM object
# plus its first enumeration. A worker that is slow to start is a worker nothing waits for.
$bootSw = [Diagnostics.Stopwatch]::StartNew()
$shellWindows = 0
try {
  $shellWindows = @(Get-ShellWindows).Count
} catch {
  # No shell windows at all, or COM refused. The diff path still works; the reuse path
  # will report `how:"none"`, which is the honest answer for a tool that is not there.
  $script:shell = $null
}
Write-Output ('@HD-WORKER-READY@ {"warm_ms":' + $bootSw.ElapsedMilliseconds + ',"shell_windows":' + $shellWindows + ',"com":' + $(if ($null -ne $script:shell) { 'true' } else { 'false' }) + '}')

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }        # the server is gone; so are we
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $job = $null
  try { $job = ConvertFrom-Json $line } catch { continue }
  if ($null -eq $job -or $null -eq $job.cmd) { continue }

  switch ([string]$job.cmd) {
    'arm' {
      $id = [string]$job.id
      $armed[$id] = [HdWin]::Snapshot()
      [void]$armedOrder.Add($id)
      # A click whose `raise` never arrives (the hand-off failed after arming) must not
      # leak a snapshot. Bounded by count, oldest first.
      while ($armedOrder.Count -gt 8) {
        $oldest = [string]$armedOrder[0]
        [void]$armedOrder.RemoveAt(0)
        if ($armed.ContainsKey($oldest)) { $armed.Remove($oldest) }
      }
    }
    'raise' {
      $out = $null
      try { $out = Invoke-RaiseJob $job } catch {
        $out = '{"id":' + (ConvertTo-Json ([string]$job.id) -Compress) + ',"raised":false,"vis":false,"how":"error","hwnd":0,"armed":false,"touch":[],"ms":0,"error":' + (ConvertTo-Json ([string]$_.Exception.Message) -Compress) + '}'
      }
      Write-Output ('@HD-RAISE@ ' + $out)
    }
    'probe' {
      # §13.10: is the remembered window still there, and still a folder window? Both
      # checks are local to this side — `IsWindow` asks the window manager about a handle,
      # `GetClassName` reads the class this process already has a handle to — so answering
      # costs about a millisecond and never goes near the shell. That is what makes it
      # affordable to put the ANSWER on the click's path while keeping the DECISION off it.
      # A window that is not a folder window is reported as not-ours rather than as gone:
      # the caller may not treat a recycled handle as the window it remembered.
      $alive = $false
      $folder = $false
      $hp = [IntPtr][int64]0
      try { $hp = [IntPtr][int64]$job.hwnd } catch { $hp = [IntPtr][int64]0 }
      if ($hp.ToInt64() -ne 0) {
        try {
          if ([HdWin]::IsWindow($hp)) {
            $alive = $true
            $folder = [HdWin]::IsFolderWindow($hp)
          }
        } catch { $alive = $false; $folder = $false }
      }
      Write-Output ('@HD-PROBE@ {"id":' + (ConvertTo-Json ([string]$job.id) -Compress) +
        ',"alive":' + $(if ($alive) { 'true' } else { 'false' }) +
        ',"folder":' + $(if ($folder) { 'true' } else { 'false' }) +
        ',"hwnd":' + $(if ($alive) { $hp.ToInt64() } else { 0 }) +
        '}')
    }
    'quit' { $running = $false }
    default { }
  }
}
