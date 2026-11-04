#!/usr/bin/env python3
"""
Skybreak Protocol local server, launched by start.command.

It does two things:
1. Serves the game files, sending Cache-Control: no-store on every file.
   (Python's built-in http.server sends no cache headers, so Chrome can keep using stale
   JS modules from its cache after a refresh. That caused the old "no hangar on start" bug.)
2. Receives saves: POST /save writes save.txt in this folder.
   A web page has no permission to write to disk, so this local server writes it instead.

Security:
- Listens on 127.0.0.1 only; other devices on the network can't reach it.
- POST requires the custom header X-Skybreak: 1. Browsers send an OPTIONS preflight before
  any cross-site request with a custom header, and this server never answers the preflight,
  so other websites open on your computer can't overwrite your save.
- Only ever writes the fixed file name save.txt; the path never comes from the request (no path traversal).
- 512KB limit, must be a JSON object, written to a temp file then atomically replaced
  (a power cut mid-write can't corrupt the save).
"""
import http.server
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SAVE_FILE = os.path.join(HERE, 'save.txt')
MAX_BYTES = 512 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        # Tells the game it is talking to this server. A static host (GitHub Pages, itch.io) may also serve a
        # save.txt if one was uploaded by mistake; without this header the game ignores it, so one person's
        # save can never overwrite every visitor's progress.
        self.send_header('X-Skybreak-Server', '1')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_POST(self):
        if self.path != '/save':
            self.send_error(404)
            return
        if self.headers.get('X-Skybreak') != '1':
            self.send_error(403, 'missing X-Skybreak header')
            return
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BYTES:
            self.send_error(413, 'bad size')
            return
        raw = self.rfile.read(n)
        try:
            data = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, 'not JSON')
            return
        if not isinstance(data, dict):
            self.send_error(400, 'expected a JSON object')
            return

        tmp = SAVE_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SAVE_FILE)          # atomic replace

        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
