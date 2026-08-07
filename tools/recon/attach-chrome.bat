@echo off
REM ==========================================================================
REM  pt-recon — start a dedicated Chrome you log into ONCE.
REM
REM  Double-click this. A normal Chrome window opens with:
REM    - its OWN profile (%LOCALAPPDATA%\pt-recon-chrome) that REMEMBERS your
REM      logins across restarts, and
REM    - a debug port (9222) so pt-recon can attach and capture your live,
REM      already-logged-in session.
REM
REM  First run: log into the terminals you want (Axiom, Padre, ... — Google,
REM  wallet, whatever). Leave the window open. Then tell pt-recon to capture:
REM      node tools/recon/ptrecon.js capture --site axiom --attach http://127.0.0.1:9222 --auto "<urls>"
REM
REM  pt-recon NEVER handles your password — you sign in by hand, once. It only
REM  attaches to the session you opened, and never closes this window.
REM ==========================================================================
setlocal
set "PROFILE=%LOCALAPPDATA%\pt-recon-chrome"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Could not find chrome.exe in Program Files. Edit CHROME= in this file to your Chrome path.
  pause
  exit /b 1
)
echo Starting pt-recon's Chrome ^(debug port 9222, profile that remembers logins^)...
echo Log into your terminals in this window, then leave it open while pt-recon captures.
start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check %*
endlocal
