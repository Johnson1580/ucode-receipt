"""上傳程式測試：用本機假的 device-api 跑完整流程（不碰正式系統）。
測：上傳每頁、同檔不重複上傳、清 C 槽已上傳舊檔、自動更新、外接硬碟沒接時記待補且接回後補齊、每日備份下載、斷線時檔案留著下次補傳、
設定檔填錯的訊息、同一台只能開一個。
用法：.venv/bin/python uploader/test_uploader.py
"""
import base64
import hashlib
import os
import time
import io
import json
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import uploader as U  # noqa: E402


class Fake:
    uploads: dict = {}
    puts: list = []
    finished: list = []
    heartbeats: list = []
    down = False
    latest: dict = {"version": None}
    exe = b""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_POST(self):
        if Fake.down:
            return self.reply(503, {"error": "down"})
        d = json.loads(self.body() or b"{}")
        if self.path == "/device-api/upload/start":
            h = d["file_hash"]
            if h in Fake.uploads:
                return self.reply(200, {"duplicate": True, "upload_id": Fake.uploads[h]})
            uid = f"u{len(Fake.uploads) + 1}"
            Fake.uploads[h] = uid
            port = self.server.server_address[1]
            return self.reply(200, {"upload_id": uid, "pages": [{"page_no": n, "url": f"http://127.0.0.1:{port}/put/{uid}/{n}",
                                                                "mirror_url": f"http://127.0.0.1:{port}/put/{uid}/{n}_m"}
                                                               for n in range(1, d["page_count"] + 1)]})
        if self.path == "/device-api/upload/finish":
            Fake.finished.append(d["upload_id"])
            return self.reply(200, {"ok": True})
        if self.path == "/device-api/heartbeat":
            Fake.heartbeats.append(d["status"])
            return self.reply(200, {"ok": True, "backup_time": "00:00"})
        self.reply(404, {})

    def do_PUT(self):
        data = self.body()
        im = Image.open(io.BytesIO(data))
        im.verify()  # 必須是正常的 JPEG
        if self.path.endswith("_m"):
            assert max(im.size) <= 1200, im.size  # 翻轉圖長邊 1200
        Fake.puts.append(self.path)
        self.reply(200, {})

    def do_GET(self):
        if self.path == "/device-api/uploader/latest":
            assert self.headers["Authorization"] == "Bearer UP"
            return self.reply(200, Fake.latest)
        if self.path == "/exe":
            self.send_response(200)
            self.end_headers()
            return self.wfile.write(Fake.exe)
        if self.path.startswith("/device-api/backup/daily"):
            assert self.headers["Authorization"] == "Bearer BK"
            day = self.path.split("date=")[1]
            return self.reply(200, {"date": day, "files": [{"name": f"收款紀錄_{day}.xlsx", "data": base64.b64encode(b"x").decode()}]})
        self.reply(404, {})


def make_pdf(path: Path, pages: int, seed: int):
    imgs = [Image.new("RGB", (1700, 1000), (255, 255 - seed, 255 - i * 10)) for i in range(pages)]
    imgs[0].save(path, "PDF", resolution=200, save_all=True, append_images=imgs[1:])


def config_errors(tmp: Path):
    """設定檔常見的填錯方式都要給看得懂的訊息"""
    p = tmp / "bad" / "config.json"
    p.parent.mkdir()

    def err():
        try:
            U.Config(p)
        except U.ConfigError as e:
            return str(e)
        raise AssertionError("應該要報錯")

    assert "找不到設定檔" in err()
    (p.parent / "config.json.txt").write_text("{}", encoding="utf-8")
    assert ".txt" in err()
    p.write_text('{\n "api_url": "x",\n "watch_dir": "D:\\掃描收款"\n}', encoding="utf-8")  # 反斜線只打一個
    assert "第 3 行" in err() and "反斜線" in err(), err()
    p.write_text('{"api_url": "x", "watch_dir": "D:\\\\掃描收款"}', encoding="utf-8")
    assert "upload_token" in err()
    p.write_text('{"api_url": "x", "upload_token": "uc_up_……（系統設定 → 新增上傳金鑰）", "watch_dir": "C:\\\\a"}', encoding="utf-8")
    assert "還不是金鑰" in err()
    p.write_bytes('{"api_url": "x", "upload_token": "uc_up_abc", "watch_dir": "D:\\\\掃描收款"}'.encode("cp950"))  # 舊版記事本存成 ANSI
    assert "UTF-8" in err()
    p.write_bytes(b"\xef\xbb\xbf" + '{"api_url": "x", "upload_token": "uc_up_abc", "watch_dir": "D:\\\\掃描收款"}'.encode())  # 記事本「UTF-8 (BOM)」
    assert str(U.Config(p).watch_dir).endswith("掃描收款")


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp())
    watch, hdd = tmp / "scan", tmp / "hdd"
    watch.mkdir()
    cfg_path = tmp / "config.json"
    cfg_path.write_text(json.dumps({"api_url": f"http://127.0.0.1:{srv.server_address[1]}/device-api", "upload_token": "UP",
                                    "backup_token": "BK", "watch_dir": str(watch), "hdd_dir": str(hdd)}), encoding="utf-8")
    U.BASE = tmp
    U.setup_logging()
    cfg = U.Config(cfg_path)
    cfg.state_path = tmp / "state.json"
    up = U.Uploader(cfg)

    def two_rounds():
        up.tick()
        up.tick()

    # 1. 一般上傳：3 頁 PDF
    make_pdf(watch / "scan1.pdf", 3, 1)
    two_rounds()
    assert len(Fake.puts) == 3 * 2 and Fake.finished == ["u1"], (Fake.puts, Fake.finished)  # 每頁原圖＋翻轉圖
    assert not (watch / "scan1.pdf").exists(), "上傳後移到已上傳"
    assert list((watch / "已上傳").rglob("scan1.pdf")), "已上傳資料夾有檔"
    assert list(hdd.rglob("scan1.pdf")), "外接硬碟有備份"

    # 2. 同內容再放一次：不重複上傳
    shutil.copy(next((watch / "已上傳").rglob("scan1.pdf")), watch / "scan1_again.pdf")
    two_rounds()
    assert len(Fake.puts) == 6 and len(Fake.finished) == 1, "同檔不重複上傳"

    # 3. 雲端斷線：檔案留著，恢復後補傳
    Fake.down = True
    make_pdf(watch / "scan2.pdf", 2, 2)
    two_rounds()
    assert (watch / "scan2.pdf").exists() and up.status == "error"
    Fake.down = False
    two_rounds()
    assert not (watch / "scan2.pdf").exists() and len(Fake.puts) == 10 and up.status == "ok"

    # 4. 外接硬碟拔掉：記待補，接回後補齊
    hdd.rename(tmp / "hdd_off")
    hdd.write_text("not a dir")  # 讓路徑無法寫入，模擬硬碟不在
    make_pdf(watch / "scan3.pdf", 1, 3)
    two_rounds()
    assert len(up.state.pending_hdd) == 1 and up.status == "error" and "外接硬碟" in up.message
    up.heartbeat()
    assert Fake.heartbeats[-1]["hdd_connected"] is False
    hdd.unlink()
    (tmp / "hdd_off").rename(hdd)
    two_rounds()
    assert not up.state.pending_hdd and list(hdd.rglob("scan3.pdf")), "接回後補齊"
    assert len(list(hdd.rglob("*.pdf"))) == 4, list(hdd.rglob("*.pdf"))  # scan1、scan1_again、scan2、scan3

    # 5. 每日備份：補最近 31 天（測試環境的備份時間 00:00，今天也會下載）
    up.heartbeat()
    up.daily_backup()
    assert len(up.state.backed_up_days) == 31 and len(list(hdd.rglob("收款紀錄_*.xlsx"))) == 31
    up.daily_backup()
    assert len(list(hdd.rglob("收款紀錄_*.xlsx"))) == 31, "已備份的日期不重複下載"

    # 6. JPG 與多頁 TIFF
    Image.new("RGB", (800, 600), "white").save(watch / "a.jpg")
    frames = [Image.new("RGB", (800, 600), c) for c in ("white", "gray")]
    frames[0].save(watch / "b.tif", save_all=True, append_images=frames[1:])
    two_rounds()
    assert len(Fake.puts) == (6 + 3) * 2, Fake.puts

    # 7. 掃描資料夾不見：亮紅燈、說明原因
    watch.rename(tmp / "scan_off")
    up.tick()
    assert up.status == "error" and "找不到掃描資料夾" in up.message, up.message
    (tmp / "scan_off").rename(watch)
    two_rounds()
    assert up.status == "ok"

    # 9. 清 C 槽「已上傳」：超過 7 天且外接硬碟有同樣大小那份才刪；硬碟還沒補到的、沒備份的、最近的都不刪
    up_root = watch / "已上傳"
    files = sorted(p for p in up_root.rglob("*") if p.is_file())
    old_t = time.time() - 10 * 86400
    for f in files:
        os.utime(f, (old_t, old_t))
    recent = files[0]
    os.utime(recent, None)
    no_twin = files[1].with_name("沒有備份.pdf")
    no_twin.write_bytes(b"x")
    os.utime(no_twin, (old_t, old_t))
    pend = files[2]
    up.state.pending_hdd.append({"path": str(pend), "at": "2026-01-01T00:00:00+08:00"})
    up.cfg.keep_local_days = 0
    up.cleanup_local()
    assert all(f.exists() for f in files), "keep_local_days=0 不刪"
    up.cfg.keep_local_days = 7
    up.cleanup_local()
    left = sorted(p for p in up_root.rglob("*") if p.is_file())
    assert left == sorted([recent, no_twin, pend]), left
    assert all(f.exists() for f in hdd.rglob("*.pdf")), "外接硬碟的不動"
    no_twin.unlink()
    up.cleanup_local()
    assert recent.exists(), "一天只清一次"
    up.state.pending_hdd.clear()

    # 10. 自動更新：新版下載、核對 sha256、換掉 exe、啟動新版；版本沒比較新或雜湊不符就不換
    exe = tmp / "app" / "uploader.exe"
    exe.parent.mkdir()
    exe.write_bytes(b"OLD")
    launched = []
    port = srv.server_address[1]
    assert not up.check_update(exe, launched.append), "雲端沒有版本"
    Fake.exe = b"NEW VERSION"
    Fake.latest = {"version": U.VERSION, "sha256": hashlib.sha256(Fake.exe).hexdigest(), "url": f"http://127.0.0.1:{port}/exe"}
    assert not up.check_update(exe, launched.append), "同版本不更新"
    Fake.latest = {**Fake.latest, "version": "99.0.0", "sha256": "0" * 64}
    try:
        up.check_update(exe, launched.append)
        raise AssertionError("雜湊不符應該失敗")
    except RuntimeError as e:
        assert "雜湊不符" in str(e)
    assert exe.read_bytes() == b"OLD" and not launched
    Fake.latest["sha256"] = hashlib.sha256(Fake.exe).hexdigest()
    assert up.check_update(exe, launched.append)
    assert exe.read_bytes() == b"NEW VERSION" and exe.with_name("uploader.old.exe").read_bytes() == b"OLD" and launched == [exe]
    Fake.latest["version"] = U.VERSION
    assert not up.check_update(exe, launched.append)  # 新版啟動後再檢查：先刪掉上次留下的 .old
    assert not exe.with_name("uploader.old.exe").exists()
    assert U.version_tuple("1.10.0") > U.version_tuple("1.9.9")

    config_errors(tmp)
    # 8. 同一台只能開一個（只在 Windows 檢查）
    first = U.already_running()
    assert not first and U.already_running() == (sys.platform == "win32")

    srv.shutdown()
    for h in list(U.log.handlers):  # Windows 不能刪開著的記錄檔
        h.close()
        U.log.removeHandler(h)
    shutil.rmtree(tmp)
    print("上傳程式測試全部通過")


if __name__ == "__main__":
    main()
