@echo off
rem Build overlay.exe from overlay.cs.
rem Requires nothing but Windows itself: csc.exe ships with .NET Framework 4.x.
setlocal

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [x] csc.exe not found. Install .NET Framework 4.x first.
  exit /b 1
)

echo [*] building...
"%CSC%" /nologo /target:winexe /out:"%~dp0overlay.exe" /win32manifest:"%~dp0overlay.manifest" /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0overlay.cs"
if errorlevel 1 (
  echo [x] build failed
  exit /b 1
)

echo [ok] overlay.exe is ready.
endlocal
