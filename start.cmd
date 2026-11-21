@echo off
setlocal
cd /d "%~dp0"
set "YUNCE_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
 if exist "D:\Program Files\nodejs\node.exe" (set "YUNCE_NODE=D:\Program Files\nodejs\node.exe") else (
  echo Node.js 18+ is required. Install it from https://nodejs.org and run again.
  pause
  exit /b 1
 )
)
"%YUNCE_NODE%" "%~dp0start-workbench.cjs"
pause
