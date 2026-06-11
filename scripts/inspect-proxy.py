"""Tiny forward proxy: logs Claude Code API requests, forwards to DeepSeek."""
import http.server
import urllib.request
import json
import ssl

LISTEN_PORT = 9090
TARGET_BASE = "https://api.deepseek.com/anthropic"  # forward target
CAPTURED = []

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_PUT(self):
        self._forward("PUT")

    def do_DELETE(self):
        self._forward("DELETE")

    def _forward(self, method):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len > 0 else b""

        target_url = TARGET_BASE + self.path

        # ---- REQUEST SNAPSHOT ----
        req_snapshot = {
            "method": method,
            "path": self.path,
            "headers": dict(self.headers),
            "body": None,
        }
        try:
            req_snapshot["body"] = json.loads(body.decode("utf-8"))
        except Exception:
            req_snapshot["body"] = body.decode("utf-8", errors="replace")

        CAPTURED.append(req_snapshot)
        # Write full body to file for inspection
        with open("C:/Users/Administrator/Projects/ai-video-assistant/scripts/proxy-capture.json", "w", encoding="utf-8") as f:
            json.dump(req_snapshot["body"], f, indent=2, ensure_ascii=False)

        print(f"\n{'='*60}")
        print(f">>> {method} {self.path}")
        if isinstance(req_snapshot["body"], dict):
            keys = list(req_snapshot["body"].keys())
            print(f">>> Body keys: {keys}")
            if "thinking" in req_snapshot["body"]:
                t = req_snapshot["body"]["thinking"]
                print(f">>> THINKING: ON  |  type={t.get('type')}  budget_tokens={t.get('budget_tokens')}")
            else:
                print(f">>> THINKING: OFF")
            print(f">>> model: {req_snapshot['body'].get('model', 'N/A')}")
            print(f">>> max_tokens: {req_snapshot['body'].get('max_tokens', 'N/A')}")
        print(f"{'='*60}\n")

        # ---- FORWARD TO DEEPSEEK ----
        req = urllib.request.Request(target_url, data=body, method=method)
        # copy headers except host
        for k, v in self.headers.items():
            if k.lower() not in ("host", "connection", "proxy-connection"):
                req.add_header(k, v)

        ctx = ssl.create_default_context()
        try:
            resp = urllib.request.urlopen(req, context=ctx)
            resp_body = resp.read()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in ("transfer-encoding", "connection"):
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            print(f"!!! Forward error: {e}")
            self.send_response(502)
            self.end_headers()
            self.wfile.write(b"Proxy error")

    def log_message(self, format, *args):
        pass  # suppress default logging


if __name__ == "__main__":
    print(f"Proxy listening on http://localhost:{LISTEN_PORT}")
    print(f"Forwarding to {TARGET_BASE}")
    print("Run Claude with: $env:ANTHROPIC_BASE_URL='http://localhost:9090'")
    httpd = http.server.HTTPServer(("127.0.0.1", LISTEN_PORT), ProxyHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n--- CAPTURED REQUESTS ---")
        for i, r in enumerate(CAPTURED):
            print(f"\n[{i}] {r['method']} {r['path']}")
            if isinstance(r["body"], dict):
                print(f"  model: {r['body'].get('model')}")
                has_thinking = "thinking" in r["body"]
                print(f"  thinking: {'✅ YES' if has_thinking else '❌ NO'}")
                if has_thinking:
                    print(f"  thinking details: {json.dumps(r['body']['thinking'], indent=4)}")
        print("Proxy stopped.")
