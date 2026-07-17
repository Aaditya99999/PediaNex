from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from chart_plotting import ChartPlotError, generate_chart_package


class handler(BaseHTTPRequestHandler):
    def send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        self.send_json(200, {"ok": True, "message": "POST growth chart payloads here."})

    def do_POST(self) -> None:
        try:
            body_length = int(self.headers.get("content-length", "0"))
            raw_body = self.rfile.read(body_length) if body_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
            self.send_json(200, generate_chart_package(payload))
        except ChartPlotError as exc:
            self.send_json(400, {"error": str(exc)})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Request body must be valid JSON."})
        except Exception:
            self.send_json(500, {"error": "Unable to generate charts right now."})
