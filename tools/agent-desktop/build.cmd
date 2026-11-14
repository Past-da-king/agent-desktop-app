@echo off
rem Builds agent-desktop.exe with the C# compiler that ships with every Windows (.NET Framework 4.x).
rem Nothing to install. Output: bin\win-x64\agent-desktop.exe (packed by electron-builder extraResources).
rem The exe is committed because the installer is built on Linux where this compiler does not exist:
rem after changing src\Program.cs, run this on Windows and commit the new exe with the source.
setlocal
cd /d "%~dp0"
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\csc.exe" ( echo csc.exe not found at %FW% & exit /b 1 )
if not exist bin\win-x64 mkdir bin\win-x64
"%FW%\csc.exe" /nologo /target:exe /platform:x64 /optimize+ /debug- /warn:4 ^
  /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
  /out:bin\win-x64\agent-desktop.exe src\Program.cs
if errorlevel 1 exit /b 1
for %%F in (bin\win-x64\agent-desktop.exe) do echo bin\win-x64\agent-desktop.exe %%~zF bytes
