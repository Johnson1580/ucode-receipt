"""自動更新實測（GitHub 的 Windows 主機上跑，打包後）：啟動舊版 exe，假的雲端說有新版，
確認舊版會下載、換掉自己、啟動新版，而且新版接手後有回報。
用法：python uploader/e2e_update.py 舊版.exe 新版.exe（新版的 VERSION 要是 99.0.0）
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

old_exe, new_exe = Path(sys.argv[1]), Path(sys.argv[2])
NEW = new_exe.read_bytes()
versions: list = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        port = self.server.server_address[1]
        if self.path == "/device-api/uploader/latest":
            return self.reply({"version": "99.0.0", "sha256": hashlib.sha256(NEW).hexdigest(), "url": f"http://127.0.0.1:{port}/exe"})
        if self.path == "/exe":
            self.send_response(200)
            self.end_headers()
            return self.wfile.write(NEW)
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        d = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/device-api/heartbeat":
            versions.append(d["status"]["version"])
        self.reply({"ok": True, "backup_time": "23:59"})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
tmp = Path(tempfile.mkdtemp())
app, scan = tmp / "app", tmp / "scan"
app.mkdir()
scan.mkdir()
exe = app / "uploader.exe"
shutil.copy(old_exe, exe)
(app / "config.json").write_text(json.dumps({"api_url": f"http://127.0.0.1:{srv.server_address[1]}/device-api",
                                             "upload_token": "UP", "watch_dir": str(scan)}), encoding="utf-8")
subprocess.Popen([str(exe), "--no-tray"], cwd=str(app), env=dict(os.environ, YJ_FIRST_UPDATE_CHECK="3"))
try:
    deadline = time.time() + 180
    while time.time() < deadline and "99.0.0" not in versions:
        time.sleep(2)
    print("回報的版本：", versions)
    assert versions and versions[0] != "99.0.0", "舊版要先回報"
    assert "99.0.0" in versions, "新版沒有接手回報"
    assert hashlib.sha256(exe.read_bytes()).hexdigest() == hashlib.sha256(NEW).hexdigest(), "exe 沒有換成新版"
    print("自動更新實測通過")
finally:
    print((app / "uploader.log").read_text(encoding="utf-8") if (app / "uploader.log").exists() else "（沒有 uploader.log）")
    subprocess.run(["taskkill", "/F", "/T", "/IM", "uploader.exe"], capture_output=True)
    srv.shutdown()
