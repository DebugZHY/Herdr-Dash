<#
  tools/token-il.ps1 — Windows integrity-level (IL) helper for tools/pipe-probe.js

  Answers "how elevated is that process?" by reading the process token's
  TokenIntegrityLevel (info class 25) and decoding the SID's last subauthority:

      0x1000 LOW · 0x2000 MEDIUM · 0x3000 HIGH · 0x4000 SYSTEM

  Windows will not let a Medium-integrity process open the token of the
  High-integrity herdr server *for reading its groups*, but it does allow
  PROCESS_QUERY_LIMITED_INFORMATION on the process object (a process object's
  own mandatory label is normally Medium), which is all GetTokenInformation
  needs. That is why this uses OpenProcess + GetTokenInformation rather than
  anything higher-level; the technique is the one proven in
  %TEMP%\hd_il_chain.ps1, reused verbatim in shape.

  OUTPUT — always exactly ONE line of key=value tokens on stdout, so the Node
  caller parses it with a split and never needs PowerShell's formatting:

      pid=<n|none> integrity=<HIGH|MEDIUM|LOW|SYSTEM|unknown> source=<arg|sock|cim|none>

  MODES
      -ProcessId <n>   report the IL of that pid                       (source=arg)
      (no arguments)   locate the herdr SERVER: the herdr.exe whose
                       command line contains " server", cross-checked
                       against the pid in the socket file's "pid:nonce"
                       content                                       (source=sock|cim)

  Read-only: it opens handles, reads one token, closes them. It never writes,
  never signals, and never touches the herdr server.
#>
param(
  [int]$ProcessId = 0,
  [string]$SockFile = "$env:APPDATA\herdr\herdr.sock"
)

$code = @'
using System;
using System.Runtime.InteropServices;
public class HdrIL {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int acc, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr proc, int acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr info, int len, out int ret);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    // 0x1000 = PROCESS_QUERY_LIMITED_INFORMATION, the cheapest right that still
    // allows OpenProcessToken. Fall back to 0x0400 if a policy denies it.
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) p = OpenProcess(0x0400, false, pid);
    if (p == IntPtr.Zero) return "unknown";
    IntPtr t;
    if (!OpenProcessToken(p, 0x0008, out t)) { CloseHandle(p); return "unknown"; }  // 0x0008 = TOKEN_QUERY
    IntPtr buf = Marshal.AllocHGlobal(256); int ret;
    string res;
    if (!GetTokenInformation(t, 25, buf, 256, out ret)) res = "unknown";           // 25 = TokenIntegrityLevel
    else {
      IntPtr sid = Marshal.ReadIntPtr(buf);
      byte count = Marshal.ReadByte(sid, 1);
      int last = Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
      res = last == 0x1000 ? "LOW" : last == 0x2000 ? "MEDIUM" : last == 0x3000 ? "HIGH" : last == 0x4000 ? "SYSTEM" : "unknown";
    }
    Marshal.FreeHGlobal(buf); CloseHandle(t); CloseHandle(p);
    return res;
  }
}
'@
Add-Type -TypeDefinition $code

function Get-Il([int]$Target) {
  try { return [HdrIL]::Get($Target) } catch { return 'unknown' }
}

$outPid = 'none'; $il = 'unknown'; $src = 'none'

if ($ProcessId -gt 0) {
  $outPid = $ProcessId; $il = Get-Il $ProcessId; $src = 'arg'
}
else {
  # The socket file holds "pid:nonce" — the pid of the server that owns the pipe.
  $sockPid = 0
  if (Test-Path -LiteralPath $SockFile) {
    try {
      $raw = (Get-Content -LiteralPath $SockFile -Raw -ErrorAction Stop).Trim()
      $head = ($raw -split ':')[0]
      if ($head -match '^\d+$') { $sockPid = [int]$head }
    } catch { }
  }

  # Authoritative: the herdr.exe running the `server` subcommand.
  $server = $null
  try {
    $server = Get-CimInstance Win32_Process -Filter "Name='herdr.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match '\sserver(\s|$)' } |
      Select-Object -First 1
  } catch { }

  if ($server) { $outPid = $server.ProcessId; $il = Get-Il $server.ProcessId; $src = 'cim' }
  elseif ($sockPid -gt 0) { $outPid = $sockPid; $il = Get-Il $sockPid; $src = 'sock' }
}

Write-Output ("pid={0} integrity={1} source={2}" -f $outPid, $il, $src)
