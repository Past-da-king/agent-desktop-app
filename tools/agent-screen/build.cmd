@echo off
rem Builds agent-screen.exe with the C# compiler that ships with every Windows (.NET Framework 4.x).
rem Nothing to install. Output: bin\win-x64\agent-screen.exe, the file electron-builder packs
rem (apps/desktop/electron-builder.yml extraResources) and the app finds (showme/native/sidecar.ts).
rem
rem The exe is committed, because the installer is built on Linux where this compiler does not exist:
rem after changing src\, run this on Windows and commit the new exe with the source.
rem
rem Step 1 makes the COM interop types for UI Automation from the system's own UIAutomationCore.dll
rem (obj\Interop.UIA.dll, not committed); step 2 compiles and embeds the ones used (/link), so the exe
rem is one file with no dependencies beyond .NET Framework 4.x, which is part of Windows 10 and 11.
setlocal
cd /d "%~dp0"
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\csc.exe" (
  echo The .NET Framework compiler was not found at %FW%\csc.exe
  exit /b 1
)
if not exist obj mkdir obj
if not exist bin\win-x64 mkdir bin\win-x64
if not exist obj\Interop.UIA.dll (
  powershell -NoProfile -ExecutionPolicy Bypass -File src\make-interop.ps1 "%CD%\obj\Interop.UIA.dll"
  if errorlevel 1 exit /b 1
)
"%FW%\csc.exe" /nologo /target:exe /platform:x64 /optimize+ /debug- /warn:4 ^
  /win32manifest:src\app.manifest /link:obj\Interop.UIA.dll ^
  /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Management.dll ^
  /out:bin\win-x64\agent-screen.exe src\Program.cs src\Act.cs
if errorlevel 1 exit /b 1
for %%F in (bin\win-x64\agent-screen.exe) do echo bin\win-x64\agent-screen.exe %%~zF bytes
