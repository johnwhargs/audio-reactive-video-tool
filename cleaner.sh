#!/bin/bash
# Launch MP4 Cleaner as a Chromium app window
# Starts Flask server, opens Chrome --app, kills server on close

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8080
URL="http://localhost:$PORT/cleaner"

# Start server in background
cd "$DIR"
python3 server.py &
SERVER_PID=$!

# Wait for server to be ready
for i in {1..20}; do
  curl -s "http://localhost:$PORT" > /dev/null && break
  sleep 0.3
done

# Find Chrome
CHROME=""
if [ -d "/Applications/Google Chrome.app" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -d "/Applications/Chromium.app" ]; then
  CHROME="/Applications/Chromium.app/Contents/MacOS/Chromium"
elif command -v google-chrome &> /dev/null; then
  CHROME="google-chrome"
elif command -v chromium &> /dev/null; then
  CHROME="chromium"
fi

if [ -z "$CHROME" ]; then
  echo "No Chrome/Chromium found. Open manually: $URL"
  wait $SERVER_PID
else
  "$CHROME" --app="$URL" --window-size=700,800 2>/dev/null
  # Kill server when Chrome window closes
  kill $SERVER_PID 2>/dev/null
fi
