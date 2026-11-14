param(
  [Parameter(Mandatory)][string]$Asar,        # the app.asar to run
  [Parameter(Mandatory)][string]$Tag,        # run name
  [int]$Seconds = 60,
  [int]$Port = 9340,
  [string]$OnlyTool = '',
  [switch]$NoTypist,
  [switch]$Blame,
  [switch]$Os,
  [switch]$Exp,
  [switch]$Focused   # tell the app it is the window he is in, so focus-keeper acts (proof only)
)
$ErrorActionPreference = 'Stop'
$Build = 'C:\temp\focus-proof\shell'
Copy-Item -Force $Asar (Join-Path $Build 'resources\app.asar')
$root = 'C:\temp\focus-proof'
$ud = Join-Path $root "ud-$Tag"
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }
New-Item -ItemType Directory -Force $ud | Out-Null
[IO.File]::WriteAllText((Join-Path $ud 'settings.json'), '{"onboarded":true,"userName":"Tester","agentName":"Hina"}', (New-Object Text.UTF8Encoding($false)))

Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
'@
$fgBefore = [Fg]::GetForegroundWindow()

# the test page (own node process)
$site = Start-Process -FilePath 'node' -ArgumentList (Join-Path $root 'site\server.mjs') -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 700

$text = (Get-Content (Join-Path $root 'source.txt') -Raw).Trim()
$out = Join-Path $root "result-$Tag.json"
if (Test-Path $out) { Remove-Item $out }
$spec = @{ out = $out; seconds = $Seconds; text = $text; cps = 6; url = 'http://probe.example.com:8765/'; typist = (-not $NoTypist.IsPresent) }
if ($OnlyTool -ne '') { $spec.onlyTool = $OnlyTool }
if ($Blame) { $spec.blame = $true }
if ($Os) { $spec.routeLikeOs = $true }
if ($Exp) { $spec.exp = $true }
if ($Focused) { $env:AGENT_FOCUS_PROBE_FOCUSED = '1' } else { Remove-Item Env:AGENT_FOCUS_PROBE_FOCUSED -ErrorAction SilentlyContinue }
$specFile = Join-Path $root "spec-$Tag.json"
[IO.File]::WriteAllText($specFile, ($spec | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

$env:AGENT_USER_DATA = $ud
if ($env:FX) { $env:AGENT_FOCUS_X = $env:FX } else { Remove-Item Env:AGENT_FOCUS_X -ErrorAction SilentlyContinue }
$env:AGENT_FOCUS_PROBE = $specFile
$exe = Join-Path $Build 'Agent.exe'
$logFile = Join-Path $root "stdout-$Tag.log"
$app = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port", '--host-resolver-rules="MAP probe.example.com 127.0.0.1"' -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
Write-Host "app pid $($app.Id) site pid $($site.Id)"
$t0 = Get-Date
while (-not (Test-Path $out) -and ((Get-Date) - $t0).TotalSeconds -lt ($Seconds + 200)) {
  Start-Sleep -Seconds 2
  if ($app.HasExited) { Write-Host 'app exited'; break }
}
$fgAfter = [Fg]::GetForegroundWindow()
Write-Host "foreground before=$fgBefore after=$fgAfter"
Start-Sleep -Seconds 2
# stop only our own processes (and their children by parent pid)
$kids = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id } | Select-Object -ExpandProperty ProcessId
foreach ($k in $kids) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $site.Id -Force -ErrorAction SilentlyContinue
Write-Host "done; result exists: $(Test-Path $out)"

