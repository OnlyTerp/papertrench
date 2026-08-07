#!/usr/bin/env bash
# pt-recon — start a dedicated Chrome you log into ONCE (mac/Linux).
#
# Run this. A normal Chrome window opens with its own profile (~/.pt-recon-chrome)
# that REMEMBERS your logins, and a debug port (9222) so pt-recon can attach and
# capture your live, already-logged-in session. Log into your terminals once,
# leave the window open, then:
#   node tools/recon/ptrecon.js capture --site axiom --attach http://127.0.0.1:9222 --auto "<urls>"
#
# pt-recon NEVER handles your password — you sign in by hand, once.
set -e
PROFILE="${PT_RECON_CHROME_PROFILE:-$HOME/.pt-recon-chrome}"
CHROME=""
for c in "$PT_RECON_CHROME" \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "$(command -v google-chrome 2>/dev/null)" \
         "$(command -v google-chrome-stable 2>/dev/null)" \
         "$(command -v chromium 2>/dev/null)" \
         "$(command -v chromium-browser 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "Could not find Chrome/Chromium. Set PT_RECON_CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi
echo "Starting pt-recon's Chrome (debug port 9222, profile that remembers logins)…"
echo "Log into your terminals in this window, then leave it open while pt-recon captures."
exec "$CHROME" --remote-debugging-port=9222 --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check "$@"
