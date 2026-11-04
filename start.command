#!/bin/bash
# Double-click me: starts the local server and opens the game (server logic is in server.py)
cd "$(dirname "$0")"
PORT=8765
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "Skybreak Protocol → http://localhost:$PORT"
echo "Your progress is saved to: $(pwd)/save.txt"
echo "(close this window to stop the server)"
(sleep 1 && open "http://localhost:$PORT") &
python3 server.py "$PORT"
