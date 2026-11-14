# Makes the COM interop assembly for UI Automation from the system's own type library, the way tlbimp
# would, without needing the Windows SDK. Called by ..\build.cmd; the result is only a compile-time input.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
public class InteropSink : ITypeLibImporterNotifySink {
  public void ReportEvent(ImporterEventKind kind, int code, string message) { }
  public Assembly ResolveRef(object typeLib) { return null; }
}
public static class InteropMaker {
  [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void LoadTypeLibEx(string file, int regkind, [MarshalAs(UnmanagedType.Interface)] out object typeLib);
  public static void Make(string dll, string outFile) {
    object lib;
    LoadTypeLibEx(dll, 2, out lib);
    AssemblyBuilder assembly = new TypeLibConverter().ConvertTypeLibToAssembly(lib, outFile, TypeLibImporterFlags.None, new InteropSink(), null, null, "UIA", null);
    assembly.Save(System.IO.Path.GetFileName(outFile));
  }
}
'@
$folder = Split-Path -Parent $Out
if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Force $folder | Out-Null }
Set-Location $folder
[InteropMaker]::Make("$env:WINDIR\System32\UIAutomationCore.dll", $Out)
Write-Host "made $Out"
