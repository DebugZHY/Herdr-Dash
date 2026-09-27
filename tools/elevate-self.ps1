<#
  tools/elevate-self.ps1 - ask Windows for an elevated copy of herdr-dash.cmd

  The launcher has exactly one thing to say to Windows: "run this same file
  again, elevated, and tell me whether you agreed". That used to be a single
  249-character `powershell -Command "..."` line inside the .cmd, which was
  both over the line-length limit the launcher now holds itself to and made
  its correctness depend on nested double quotes surviving cmd's parsing and
  PowerShell's in that order. Both problems go away by giving the code a file
  to live in and an argument list instead of a quoted sentence.

  WHERE THE VALUES COME FROM
  -Exe is how the launcher calls this: a filesystem path, which cannot contain
  a double quote, so quoting it on the command line is ordinary and safe.
  -Arguments is NOT passed that way, and that is deliberate. It is the
  launcher's own %* - the user's command line, which may well contain quotes -
  and it travels through the environment instead, where no amount of quoting
  can mangle it. That is what the old inline version did, and it is the one
  property of it worth keeping. A caller that has a known-safe argument string
  can still pass -Arguments explicitly.

  WHY THE MARKER IS SET HERE AND NOT BY THE CALLER
  The elevated copy must know it IS the elevated copy, or it would ask to be
  elevated again - and again. The marker is therefore part of the command
  string, prepended to the `call`, so it is in place before the launcher's
  first line runs in the new window:
      set HD_ELEVATED=1&&call "<the launcher>" <the arguments>
  `&&` terminates the SET, so the value is exactly "1" and not "1 ".

  EXIT
      0  the elevated copy was launched (Windows agreed)
      1  it was not - UAC was refused, this session cannot show a prompt at
         all (a scheduled task, a service, a disconnected session), or there
         was no launcher to relaunch

  There is no -Wait and no polling: this returns the moment the decision is
  made, so nothing here can hang. -ErrorAction Stop is what makes a refusal
  land in the catch: Start-Process reports a refused prompt as a
  NON-terminating error, which `catch` would otherwise sail straight past -
  and the launcher would then announce success and quietly do nothing.
#>
param(
  [string]$Exe = '',
  [string]$Arguments = ''
)

if (-not $Exe) { $Exe = $env:HD_RL_EXE }
if (-not $Arguments) { $Arguments = $env:HD_RL_ARGS }

# Nothing to relaunch. Unreachable from the launcher, which always sets
# HD_RL_EXE first - but "no elevated copy is coming" is the honest answer, and
# exit 1 is the code that already means exactly that.
if (-not $Exe) { exit 1 }

# Built rather than written: a double quote is assembled at runtime so this
# file needs no nested quoting of its own.
$q = [char]34
$cmd = 'set HD_ELEVATED=1&&call ' + $q + $Exe + $q
if ($Arguments) { $cmd = $cmd + ' ' + $Arguments }

try {
  Start-Process -FilePath $env:ComSpec -Verb RunAs -ArgumentList '/c', $cmd -ErrorAction Stop
} catch {
  exit 1
}

exit 0
