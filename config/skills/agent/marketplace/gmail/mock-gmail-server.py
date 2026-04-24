#!/usr/bin/env python3
"""
Local mock of the Gmail v1 users/me API surface, used by execute.live.test.sh
to exercise the happy path of the gmail skill without hitting Google.

Routing is path-prefix based and matches the routes that execute.sh actually
calls. Each route returns a canned 200 JSON body that mirrors the shape of a
real Gmail response, just enough for the skill's `jq` / `python3` parsers.

The server stores a small in-memory state for label management actions so a
test can call mark-as-read / mark-as-unread / add-label / remove-label and
observe the labelIds round-trip.

Usage (test driver):
    python3 mock-gmail-server.py --port 0 --token-mode pass     # any token works
    python3 mock-gmail-server.py --port 0 --token-mode 401      # always 401

Stdout: a single line `LISTENING <port>` once the socket is bound, then HTTP
access logs. SIGTERM / SIGINT shuts down cleanly.
"""

import argparse
import json
import os
import signal
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Mutated by handlers; protected by a lock since ThreadingHTTPServer spawns
# one thread per request.
_state_lock = threading.Lock()
_message_state = {
    # Default test message — labels evolve across mark-as-read / add-label calls.
    "MSG_TEST_001": {
        "id": "MSG_TEST_001",
        "threadId": "THREAD_TEST_001",
        "labelIds": ["INBOX", "UNREAD"],
        "snippet": "Mocked test message snippet.",
        "subject": "Mock subject — happy path",
        "from": "mock-sender@example.com",
        "to": "test@example.com",
        "date": "Thu, 24 Apr 2026 18:00:00 -0400",
        "body_plain": "Hello from the mock server.\nThis is the plain-text body.\n",
    },
}

_TOKEN_MODE = "pass"  # set from CLI; "pass" | "401" | "500"


def _ok(handler, body):
    raw = json.dumps(body).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _err(handler, code, message):
    body = {
        "error": {"code": code, "message": message, "status": "ERROR"},
    }
    raw = json.dumps(body).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _check_auth(handler):
    """Return True iff the request has any Bearer token (in pass mode), else
    return False after writing the configured error response."""
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        _err(handler, 401, "Missing or malformed Authorization header")
        return False
    if _TOKEN_MODE == "401":
        _err(handler, 401, "Invalid Credentials")
        return False
    if _TOKEN_MODE == "500":
        _err(handler, 500, "Backend error")
        return False
    return True


def _build_full_message(state):
    """Build a Gmail-shaped message payload (format=full) from internal state."""
    import base64

    body_b64 = base64.urlsafe_b64encode(
        state["body_plain"].encode("utf-8")
    ).decode("ascii").rstrip("=")
    return {
        "id": state["id"],
        "threadId": state["threadId"],
        "labelIds": state["labelIds"],
        "snippet": state["snippet"],
        "payload": {
            "headers": [
                {"name": "From", "value": state["from"]},
                {"name": "To", "value": state["to"]},
                {"name": "Subject", "value": state["subject"]},
                {"name": "Date", "value": state["date"]},
            ],
            "mimeType": "text/plain",
            "body": {"data": body_b64, "size": len(state["body_plain"])},
        },
    }


def _build_metadata_message(state):
    """Build a Gmail-shaped message payload (format=metadata)."""
    return {
        "id": state["id"],
        "threadId": state["threadId"],
        "labelIds": state["labelIds"],
        "snippet": state["snippet"],
        "payload": {
            "headers": [
                {"name": "Subject", "value": state["subject"]},
                {"name": "From", "value": state["from"]},
                {"name": "Date", "value": state["date"]},
            ],
        },
    }


class MockHandler(BaseHTTPRequestHandler):
    # Quiet the default access log (line per request to stderr) — comment out
    # this method to debug routing.
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + (fmt % args) + "\n")

    # ---- GET --------------------------------------------------------------

    def do_GET(self):
        if not _check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        # /gmail/v1/users/me/messages?q=...&maxResults=...
        if path.endswith("/messages"):
            max_n = int(qs.get("maxResults", ["10"])[0])
            with _state_lock:
                ids = list(_message_state.keys())[:max_n]
            return _ok(
                self,
                {
                    "messages": [
                        {"id": i, "threadId": _message_state[i]["threadId"]} for i in ids
                    ],
                    "resultSizeEstimate": len(ids),
                },
            )

        # /gmail/v1/users/me/messages/{id}?format=full|metadata
        if "/messages/" in path:
            mid = path.rsplit("/", 1)[-1]
            with _state_lock:
                state = _message_state.get(mid)
            if not state:
                return _err(self, 404, f"Message {mid} not found")
            fmt = qs.get("format", ["full"])[0]
            if fmt == "metadata":
                return _ok(self, _build_metadata_message(state))
            return _ok(self, _build_full_message(state))

        # /gmail/v1/users/me/labels
        if path.endswith("/labels"):
            return _ok(
                self,
                {
                    "labels": [
                        {"id": "INBOX", "name": "INBOX", "type": "system"},
                        {"id": "UNREAD", "name": "UNREAD", "type": "system"},
                        {"id": "SENT", "name": "SENT", "type": "system"},
                        {"id": "STARRED", "name": "STARRED", "type": "system"},
                        {"id": "Label_5", "name": "Work", "type": "user"},
                        {"id": "Label_7", "name": "Personal", "type": "user"},
                    ]
                },
            )

        return _err(self, 404, f"Mock has no route for GET {path}")

    # ---- POST -------------------------------------------------------------

    def do_POST(self):
        if not _check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {}

        # /gmail/v1/users/me/messages/send
        if path.endswith("/messages/send"):
            # Decode the base64url-encoded RFC-2822 payload just enough to
            # confirm the skill produced something parseable.
            import base64

            raw_b64 = payload.get("raw", "")
            try:
                pad = "=" * (-len(raw_b64) % 4)
                base64.urlsafe_b64decode(raw_b64 + pad).decode("utf-8", errors="ignore")
            except Exception:
                return _err(self, 400, "Invalid raw MIME — base64 decode failed")
            return _ok(
                self,
                {
                    "id": "MOCK_SENT_001",
                    "threadId": "THREAD_SENT_001",
                    "labelIds": ["SENT"],
                },
            )

        # /gmail/v1/users/me/messages/{id}/modify
        if "/messages/" in path and path.endswith("/modify"):
            # Path is .../messages/{id}/modify
            mid = path.rsplit("/", 2)[-2]
            add = payload.get("addLabelIds") or []
            remove = payload.get("removeLabelIds") or []
            with _state_lock:
                state = _message_state.get(mid)
                if not state:
                    return _err(self, 404, f"Message {mid} not found")
                # Apply removes first, then adds. De-dupe.
                new_labels = [lab for lab in state["labelIds"] if lab not in remove]
                for lab in add:
                    if lab not in new_labels:
                        new_labels.append(lab)
                state["labelIds"] = new_labels
            return _ok(
                self,
                {
                    "id": state["id"],
                    "threadId": state["threadId"],
                    "labelIds": state["labelIds"],
                },
            )

        return _err(self, 404, f"Mock has no route for POST {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token-mode", choices=["pass", "401", "500"], default="pass")
    args = parser.parse_args()

    global _TOKEN_MODE
    _TOKEN_MODE = args.token_mode

    server = ThreadingHTTPServer(("127.0.0.1", args.port), MockHandler)
    bound_port = server.server_address[1]
    # Single line on stdout so the test driver can grep it and learn the port.
    sys.stdout.write(f"LISTENING {bound_port}\n")
    sys.stdout.flush()

    def _shutdown(signum, frame):
        sys.stderr.write("[mock] shutting down\n")
        server.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
