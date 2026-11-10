# Proof only: plays a few real mouse and key events so proof.mjs can see them arrive through the hooks.
# The product never does this; agent-screen.exe has no code that sends input.
#   -Actions "click:812,304;wheel:812,304,-1;key:Escape;key:a;paste;move:0x1234,700,60"
param([string]$Actions)
Add-Type -Namespace ProofInput -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[StructLayout(LayoutKind.Sequential)] public struct Pt { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool GetCursorPos(out Pt pt);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
[void][ProofInput.Api]::SetThreadDpiAwarenessContext([IntPtr](-4))
$saved = New-Object 'ProofInput.Api+Pt'
[void][ProofInput.Api]::GetCursorPos([ref]$saved)
$keys = @{ Escape = 0x1B; Enter = 0x0D; Tab = 0x09; a = 0x41 }
foreach ($action in $Actions.Split(';')) {
  $kind, $arg = $action.Split(':', 2)
  if ($kind -eq 'click') {
    $x, $y = $arg.Split(',')
    [void][ProofInput.Api]::SetCursorPos([int]$x, [int]$y)
    Start-Sleep -Milliseconds 60
    [ProofInput.Api]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [ProofInput.Api]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  } elseif ($kind -eq 'wheel') {
    $x, $y, $notches = $arg.Split(',')
    [void][ProofInput.Api]::SetCursorPos([int]$x, [int]$y)
    Start-Sleep -Milliseconds 60
    $data = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$notches * 120), 0)
    [ProofInput.Api]::mouse_event(0x0800, 0, 0, $data, [UIntPtr]::Zero)
  } elseif ($kind -eq 'key') {
    $vk = [byte]$keys[$arg]
    [ProofInput.Api]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
    [ProofInput.Api]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  } elseif ($kind -eq 'paste') {
    [ProofInput.Api]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [ProofInput.Api]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
    [ProofInput.Api]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
    [ProofInput.Api]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  } elseif ($kind -eq 'move') {
    $h, $x, $y = $arg.Split(',')
    [void][ProofInput.Api]::SetWindowPos([IntPtr][Convert]::ToInt64($h, 16), [IntPtr]::Zero, [int]$x, [int]$y, 0, 0, 0x0015)
  }
  Start-Sleep -Milliseconds 150
}
[void][ProofInput.Api]::SetCursorPos($saved.X, $saved.Y)
