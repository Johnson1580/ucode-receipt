"""優碼數位 掃描自動上傳程式（裝在常駐電腦，附件一項目 1）

工作：
1. 每 10 秒檢查掃描資料夾（ES-580W 掃到這台電腦的共用資料夾）。檔案大小連續兩次不變、能開啟，才算寫入完成。
2. PDF 每頁轉成 JPEG（200 dpi、長邊 1800 像素，與辨識測試相同條件）；JPG／TIFF 直接轉。
   每頁另外產生一張左右翻轉圖（長邊 1200），雲端判斷透字頁用（雲端環境不能做影像處理）。
3. 呼叫雲端 device-api 取得上傳網址 → 逐頁上傳 → 通知排入辨識。同一檔案（內容雜湊相同）不重複上傳。
4. 成功後把原檔移到「已上傳」資料夾（年／月／日），並複製到外接硬碟備份資料夾（年／月／日）。
   外接硬碟沒接時記在待補清單，接回後自動補齊。
5. 每分鐘回報狀態（待上傳數、外接硬碟是否連接、最近一次每日備份）給雲端，系統畫面看得到。
6. 每天在設定時間（系統設定，預設 22:00）用備份金鑰下載當日收款紀錄、複核修正紀錄、收款單 Excel 到外接硬碟。
   硬碟沒接、電腦沒開的日子，之後會補下載（最多往前 30 天）。
7. Windows 工作列顯示狀態圖示（正常綠、上傳中藍、異常紅），右鍵可開系統網頁與掃描資料夾。
8. 「已上傳」資料夾只留最近幾天（config.json 的 keep_local_days，預設 7），更早的確認外接硬碟有同樣大小那份才刪，
   避免佔滿 C 槽；外接硬碟還沒補到的一律不刪。
9. 自動更新：每 6 小時問雲端有沒有新版，有就下載、核對 sha256、換掉 exe 後重新啟動（只在打包成 exe 時）。

斷線時檔案留在掃描資料夾，連線恢復後自動補傳。設定檔 config.json 與本程式放在同一個資料夾（見 config.example.json）。
用法：uploader.exe（或 python uploader.py）；測試用：python uploader.py --once
"""
import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
import traceback
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests
from PIL import Image, ImageOps, ImageSequence

VERSION = "1.0.0"
TZ = dt.timezone(dt.timedelta(hours=8), "Asia/Taipei")  # 台灣沒有夏令時間；Windows 沒有內建時區資料庫，ZoneInfo 會找不到
BASE = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
SCAN_EXT = {".pdf", ".jpg", ".jpeg", ".tif", ".tiff", ".png"}
LONG_SIDE = 1800
POLL_SECONDS = 10
HEARTBEAT_SECONDS = 60
UPDATE_CHECK_SECONDS = 6 * 3600

log = logging.getLogger("uploader")


def setup_logging():
    log.setLevel(logging.INFO)
    h = RotatingFileHandler(BASE / "uploader.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
    log.addHandler(logging.StreamHandler())


class ConfigError(Exception):
    """設定檔有錯：訊息直接顯示給到場安裝的人看"""


def read_config(path: Path) -> dict:
    if not path.exists():
        if path.with_name(path.name + ".txt").exists():
            raise ConfigError(f"設定檔的檔名變成了「{path.name}.txt」，請把最後的 .txt 刪掉（檔案總管 → 檢視 → 勾「副檔名」才看得到）。")
        raise ConfigError(f"找不到設定檔 {path}。\n請把 config.json 放在 uploader.exe 同一個資料夾。")
    try:
        c = json.loads(path.read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError:
        raise ConfigError("config.json 的編碼不對，請用記事本開啟 → 另存新檔 → 編碼選「UTF-8」。") from None
    except json.JSONDecodeError as e:
        raise ConfigError(f"config.json 第 {e.lineno} 行格式錯誤。\n常見原因：路徑的反斜線只打一個（要打兩個，例如 D:\\\\掃描收款）、"
                          "少了引號或逗號、最後一行後面多了逗號。") from None
    if not isinstance(c, dict):
        raise ConfigError("config.json 格式錯誤，內容要用 { } 包起來。")
    for k in ("api_url", "upload_token", "watch_dir"):
        if not str(c.get(k) or "").strip():
            raise ConfigError(f"config.json 少了「{k}」，請照 config.example.json 補上。")
    for k in ("upload_token", "backup_token"):
        v = str(c.get(k) or "")
        if v and not v.isascii():
            raise ConfigError(f"config.json 的「{k}」還不是金鑰（裡面有中文或說明文字），請到系統設定建立金鑰後貼上。")
    return c


class Config:
    def __init__(self, path: Path):
        c = read_config(path)
        self.api = c["api_url"].rstrip("/")             # https://xxxx.supabase.co/functions/v1/device-api
        self.web_url = c.get("web_url", "")
        self.upload_token = c["upload_token"]
        self.backup_token = c.get("backup_token", "")
        self.watch_dir = Path(c["watch_dir"])           # 掃描機存檔的共用資料夾
        self.uploaded_dir = Path(c.get("uploaded_dir") or self.watch_dir / "已上傳")
        self.hdd_dir = Path(c["hdd_dir"]) if c.get("hdd_dir") else None   # 例 E:\收款單據備份
        self.keep_local_days = int(c.get("keep_local_days", 7))          # 「已上傳」留幾天，0＝不刪
        self.state_path = BASE / "state.json"


class State:
    """本機狀態：已上傳的雜湊、待補到外接硬碟的檔案、已完成每日備份的日期"""

    def __init__(self, path: Path):
        self.path = path
        d = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.uploaded: dict = d.get("uploaded", {})          # hash -> {file, at}
        self.pending_hdd: list = d.get("pending_hdd", [])    # 已上傳但還沒複製到硬碟的檔案路徑
        self.backed_up_days: list = d.get("backed_up_days", [])
        self.last_backup: str | None = d.get("last_backup")
        self.last_cleanup: str | None = d.get("last_cleanup")
        self.lock = threading.Lock()

    def save(self):
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"uploaded": self.uploaded, "pending_hdd": self.pending_hdd,
                                       "backed_up_days": self.backed_up_days[-60:], "last_backup": self.last_backup,
                                       "last_cleanup": self.last_cleanup},
                                      ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(self.path)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


MIRROR_LONG_SIDE = 1200


def to_jpeg(img: Image.Image, long_side=LONG_SIDE, quality=90) -> bytes:
    img = img.convert("RGB")
    scale = long_side / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    b = io.BytesIO()
    img.save(b, "JPEG", quality=quality)
    return b.getvalue()


def page_images(img: Image.Image) -> tuple[bytes, bytes]:
    """一頁 → (原圖 JPEG, 左右翻轉圖 JPEG)。翻轉圖給雲端判斷透字頁用（雲端環境不能做影像處理），長邊 1200 節省空間"""
    return to_jpeg(img), to_jpeg(ImageOps.mirror(img.convert("RGB")), MIRROR_LONG_SIDE, 80)


def render_pages(p: Path) -> list[tuple[bytes, bytes]]:
    """掃描檔 → 每頁 (原圖, 翻轉圖)"""
    if p.suffix.lower() == ".pdf":
        import pymupdf
        out = []
        with pymupdf.open(p) as doc:
            for page in doc:
                pix = page.get_pixmap(dpi=200)
                out.append(page_images(Image.open(io.BytesIO(pix.tobytes("png")))))
        return out
    with Image.open(p) as im:
        return [page_images(frame.copy()) for frame in ImageSequence.Iterator(im)]


def day_dir(root: Path, when: dt.datetime) -> Path:
    return root / f"{when:%Y}" / f"{when:%m}" / f"{when:%d}"


def version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def relaunch(exe: Path):
    """啟動換好的新版。PYINSTALLER_RESET_ENVIRONMENT：新版自己解壓，不沿用這個程式結束時會刪掉的暫存資料夾"""
    import subprocess
    env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT="1")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    args = [a for a in sys.argv[1:] if a != "--after-update"]   # 沿用原本的參數（例如 --config）
    subprocess.Popen([str(exe), "--after-update", *args], cwd=str(exe.parent), env=env, close_fds=True, creationflags=flags)


class Uploader:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = State(cfg.state_path)
        self.sizes: dict[Path, int] = {}
        self.status = "ok"          # ok / busy / error
        self.message = "啟動中"
        self.backup_time = "22:00"
        self.stop = threading.Event()

    # ---------- 雲端 ----------
    def call(self, method, route, token, **kw):
        r = requests.request(method, self.cfg.api + route, headers={"Authorization": f"Bearer {token}"}, timeout=60, **kw)
        if r.status_code == 401:
            raise RuntimeError("裝置金鑰無效或已停用，請洽系統管理者")
        if not r.ok:
            raise RuntimeError(f"{route} {r.status_code}: {r.text[:200]}")
        return r.json()

    # ---------- 外接硬碟 ----------
    def hdd_ok(self) -> bool:
        d = self.cfg.hdd_dir
        if not d:
            return False
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / ".probe"
            probe.write_text("ok")
            probe.unlink()
            return True
        except OSError:
            return False

    def copy_to_hdd(self, src: Path, when: dt.datetime) -> bool:
        if not self.hdd_ok():
            return False
        dest = day_dir(self.cfg.hdd_dir, when) / src.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dest)
        return True

    def flush_pending_hdd(self):
        if not self.state.pending_hdd or not self.hdd_ok():
            return
        left = []
        for item in self.state.pending_hdd:
            src = Path(item["path"])
            try:
                if src.exists() and not self.copy_to_hdd(src, dt.datetime.fromisoformat(item["at"])):
                    left.append(item)
            except OSError as e:
                log.warning("補複製到外接硬碟失敗 %s：%s", src, e)
                left.append(item)
        if len(left) != len(self.state.pending_hdd):
            log.info("外接硬碟已補齊 %d 個掃描檔", len(self.state.pending_hdd) - len(left))
        self.state.pending_hdd = left
        self.state.save()

    # ---------- 清 C 槽「已上傳」 ----------
    def cleanup_local(self):
        """「已上傳」超過保留天數、而且外接硬碟有同樣大小那份的才刪；硬碟沒接或還沒補到的一律不刪。一天一次。"""
        days, root, hdd = self.cfg.keep_local_days, self.cfg.uploaded_dir, self.cfg.hdd_dir
        today = dt.datetime.now(TZ).strftime("%Y%m%d")
        if days <= 0 or not hdd or self.state.last_cleanup == today or not self.hdd_ok():
            return
        cutoff = time.time() - days * 86400
        pending = {str(Path(i["path"])) for i in self.state.pending_hdd}
        removed = 0
        for p in sorted(root.rglob("*")) if root.exists() else []:
            if not p.is_file() or str(p) in pending:
                continue
            try:
                st = p.stat()
                twin = hdd / p.relative_to(root)   # 外接硬碟跟「已上傳」是同樣的 年/月/日/檔名
                if st.st_mtime < cutoff and twin.is_file() and twin.stat().st_size == st.st_size:
                    p.unlink()
                    removed += 1
            except OSError as e:
                log.warning("清除已上傳的舊檔失敗 %s：%s", p, e)
        for d in sorted((d for d in root.rglob("*") if d.is_dir()), key=lambda d: len(d.parts), reverse=True) if root.exists() else []:
            try:
                d.rmdir()   # 只刪空的日期資料夾
            except OSError:
                pass
        if removed:
            log.info("已清除「已上傳」裡超過 %d 天、外接硬碟已有備份的 %d 個檔案", days, removed)
        self.state.last_cleanup = today
        self.state.save()

    # ---------- 自動更新 ----------
    def check_update(self, exe: Path | None = None, launch=relaunch) -> bool:
        """雲端有新版：下載、核對 sha256、把執行中的 exe 改名成 .old（Windows 可以改名但不能覆蓋）、新版換上後啟動。
        回傳 True 表示已啟動新版，這個程式要結束。"""
        exe = exe or (Path(sys.executable) if getattr(sys, "frozen", False) else None)
        if not exe:
            return False
        old, new = exe.with_name(exe.stem + ".old" + exe.suffix), exe.with_name(exe.stem + ".new" + exe.suffix)
        try:
            old.unlink(missing_ok=True)   # 上次更新留下的舊版
        except OSError:
            pass
        info = self.call("GET", "/uploader/latest", self.cfg.upload_token)
        v = info.get("version")
        if not v or version_tuple(v) <= version_tuple(VERSION):
            return False
        r = requests.get(info["url"], timeout=300)
        r.raise_for_status()
        if hashlib.sha256(r.content).hexdigest() != info["sha256"]:
            raise RuntimeError(f"新版 {v} 下載不完整（雜湊不符），稍後再試")
        new.write_bytes(r.content)
        exe.replace(old)
        try:
            new.replace(exe)
        except OSError:
            old.replace(exe)
            raise
        log.info("已更新到 %s，重新啟動", v)
        launch(exe)
        return True

    # ---------- 上傳 ----------
    def candidates(self) -> list[Path]:
        """寫入完成的掃描檔：大小跟上一輪一樣、而且能以獨佔方式開啟"""
        ready = []
        seen = set()
        for p in sorted(self.cfg.watch_dir.iterdir()) if self.cfg.watch_dir.exists() else []:
            if not p.is_file() or p.suffix.lower() not in SCAN_EXT or p.name.startswith(("~", ".")):
                continue
            seen.add(p)
            size = p.stat().st_size
            if size > 0 and self.sizes.get(p) == size:
                try:
                    with p.open("rb+"):
                        ready.append(p)
                except OSError:
                    pass  # 掃描機還在寫
            self.sizes[p] = size
        self.sizes = {k: v for k, v in self.sizes.items() if k in seen}
        return ready

    def upload(self, p: Path):
        h = sha256_file(p)
        now = dt.datetime.now(TZ)
        if h in self.state.uploaded:
            log.info("%s 已經上傳過（內容相同），不重複上傳", p.name)
            self.finish_local(p, now)
            return
        pages = render_pages(p)
        log.info("上傳 %s（%d 頁）", p.name, len(pages))
        start = self.call("POST", "/upload/start", self.cfg.upload_token,
                          json={"file_name": p.name, "file_hash": h, "page_count": len(pages)})
        if not start.get("duplicate"):
            for item in start["pages"]:
                original, mirrored = pages[item["page_no"] - 1]
                for url, data in ((item["url"], original), (item["mirror_url"], mirrored)):
                    r = requests.put(url, data=data, headers={"Content-Type": "image/jpeg", "x-upsert": "true"}, timeout=120)
                    if not r.ok:
                        raise RuntimeError(f"第 {item['page_no']} 頁上傳失敗 {r.status_code}: {r.text[:200]}")
            self.call("POST", "/upload/finish", self.cfg.upload_token, json={"upload_id": start["upload_id"]})
        self.state.uploaded[h] = {"file": p.name, "at": now.isoformat()}
        self.finish_local(p, now)

    def finish_local(self, p: Path, now: dt.datetime):
        dest_dir = day_dir(self.cfg.uploaded_dir, now)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / p.name
        if dest.exists():
            dest = dest_dir / f"{p.stem}_{now:%H%M%S}{p.suffix}"
        shutil.move(str(p), dest)
        try:
            ok = self.copy_to_hdd(dest, now)
        except OSError:
            ok = False
        if not ok:
            self.state.pending_hdd.append({"path": str(dest), "at": now.isoformat()})
        self.state.save()

    # ---------- 每日備份 ----------
    def daily_backup(self):
        if not self.cfg.backup_token or not self.hdd_ok():
            return
        now = dt.datetime.now(TZ)
        hh, mm = (int(x) for x in self.backup_time.split(":")[:2])
        due_today = (now.hour, now.minute) >= (hh, mm)
        days = [(now - dt.timedelta(days=i)).strftime("%Y%m%d") for i in range(30, -1, -1)]
        if not due_today:
            days = days[:-1]
        for day in days:
            if day in self.state.backed_up_days:
                continue
            try:
                data = self.call("GET", f"/backup/daily?date={day}", self.cfg.backup_token)
            except Exception as e:  # noqa: BLE001
                log.warning("每日備份 %s 失敗：%s", day, e)
                return
            target = self.cfg.hdd_dir / day[:4] / day[4:6] / day[6:] / "收款資料"
            target.mkdir(parents=True, exist_ok=True)
            for f in data["files"]:
                (target / f["name"]).write_bytes(base64.b64decode(f["data"]))
            self.state.backed_up_days.append(day)
            self.state.last_backup = now.isoformat()
            self.state.save()
            log.info("每日備份完成 %s（%d 個檔）", day, len(data["files"]))

    # ---------- 回報 ----------
    def heartbeat(self):
        pending = len([p for p in self.cfg.watch_dir.iterdir() if p.suffix.lower() in SCAN_EXT]) if self.cfg.watch_dir.exists() else 0
        status = {"version": VERSION, "pending": pending, "hdd_connected": self.hdd_ok() if self.cfg.hdd_dir else None,
                  "pending_hdd": len(self.state.pending_hdd), "last_backup": self.state.last_backup, "message": self.message}
        r = self.call("POST", "/heartbeat", self.cfg.upload_token, json={"status": status})
        self.backup_time = r.get("backup_time", self.backup_time)

    # ---------- 主迴圈 ----------
    def tick(self):
        if not self.cfg.watch_dir.is_dir():
            self.status, self.message = "error", f"找不到掃描資料夾 {self.cfg.watch_dir}，請確認 config.json 的 watch_dir"
            return
        files = self.candidates()
        for p in files:
            self.status, self.message = "busy", f"上傳中：{p.name}"
            try:
                self.upload(p)
            except Exception as e:  # noqa: BLE001 — 留在資料夾，下一輪再試
                self.status, self.message = "error", f"上傳失敗（稍後自動重試）：{e}"
                log.warning("%s 上傳失敗：%s", p.name, e)
                return
        self.flush_pending_hdd()
        if self.cfg.hdd_dir and not self.hdd_ok():
            self.status, self.message = "error", "偵測不到外接硬碟，接回後會自動補齊備份"
        else:
            self.status, self.message = "ok", "正常"

    def run(self, once=False):
        last_hb = 0.0
        first = float(os.environ.get("YJ_FIRST_UPDATE_CHECK", 120))   # 啟動 2 分鐘後第一次檢查（Windows 實測時縮短）
        last_upd = time.time() - UPDATE_CHECK_SECONDS + first
        while not self.stop.is_set():
            try:
                self.tick()
                if time.time() - last_hb > HEARTBEAT_SECONDS or once:
                    self.heartbeat()
                    self.daily_backup()
                    self.cleanup_local()
                    last_hb = time.time()
                if not once and self.status != "busy" and time.time() - last_upd > UPDATE_CHECK_SECONDS:
                    last_upd = time.time()
                    try:
                        if self.check_update():
                            self.stop.set()   # 新版已啟動，這個結束
                            break
                    except Exception as e:  # noqa: BLE001 — 更新失敗不影響上傳，下次再試
                        log.warning("自動更新失敗：%s", e)
            except Exception as e:  # noqa: BLE001
                self.status, self.message = "error", f"連不到系統：{e}"
                log.warning("迴圈錯誤：%s\n%s", e, traceback.format_exc(limit=3))
            if once:
                break
            self.stop.wait(POLL_SECONDS)


def run_tray(up: Uploader):
    """Windows 工作列圖示；沒有 pystray（例如測試環境）就只在背景執行"""
    try:
        import pystray
    except ImportError:
        up.run()
        return
    import os
    import webbrowser
    from PIL import ImageDraw

    def icon_img(color):
        im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        ImageDraw.Draw(im).ellipse((6, 6, 58, 58), fill=color)
        return im

    colors = {"ok": (31, 140, 80, 255), "busy": (44, 90, 200, 255), "error": (200, 50, 40, 255)}
    menu = pystray.Menu(
        pystray.MenuItem(lambda _: f"狀態：{up.message}", None, enabled=False),
        pystray.MenuItem("開啟系統網頁", lambda: up.cfg.web_url and webbrowser.open(up.cfg.web_url)),
        pystray.MenuItem("開啟掃描資料夾", lambda: os.startfile(up.cfg.watch_dir)),  # noqa: S606
        pystray.MenuItem("結束", lambda icon: (up.stop.set(), icon.stop())),
    )
    icon = pystray.Icon("uc-uploader", icon_img(colors["ok"]), "優碼收款單據上傳", menu)

    def refresh():
        while not up.stop.is_set():
            icon.icon = icon_img(colors[up.status])
            icon.title = f"優碼收款單據上傳：{up.message}"[:120]
            time.sleep(3)
        icon.stop()   # 自動更新後結束

    threading.Thread(target=up.run, daemon=True).start()
    threading.Thread(target=refresh, daemon=True).start()
    icon.run()


_mutex = None  # 保持開著，程式結束時 Windows 自動釋放


def already_running(wait_seconds=0) -> bool:
    """同一台電腦只能開一個（兩個會搶同一個資料夾的檔案）。只在 Windows 檢查。
    wait_seconds：自動更新後的新版要等舊版結束、放開名稱再接手。"""
    global _mutex
    if sys.platform != "win32":
        return False
    import ctypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.restype = ctypes.c_void_p
    deadline = time.time() + wait_seconds
    while True:
        _mutex = k.CreateMutexW(None, False, "Local\\UCodeReceiptUploader")
        if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
            return False
        if time.time() >= deadline:
            return True
        k.CloseHandle(ctypes.c_void_p(_mutex))
        time.sleep(1)


def alert(msg: str, error=True):
    """沒有主控台視窗（--noconsole），啟動失敗要跳視窗說明，不然看起來像沒反應"""
    log.error(msg) if error else log.info(msg)
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "優碼收款單據上傳", 0x10 if error else 0x40)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(BASE / "config.json"))
    ap.add_argument("--once", action="store_true", help="只跑一輪（測試用）")
    ap.add_argument("--after-update", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--no-tray", action="store_true", help=argparse.SUPPRESS)   # 沒有桌面的環境（GitHub 上的更新實測）
    a = ap.parse_args()
    setup_logging()
    if not a.once and already_running(60 if a.after_update else 0):
        alert("上傳程式已經在執行了（右下角工作列的圓點），不用再開一次。", error=False)
        return
    try:
        up = Uploader(Config(Path(a.config)))
    except ConfigError as e:
        alert(f"{e}\n\n修改後再點一次 uploader.exe。")
        return
    except Exception as e:  # noqa: BLE001
        alert(f"上傳程式啟動失敗：{e}\n\n詳細內容在 uploader.log。")
        log.error(traceback.format_exc())
        return
    log.info("上傳程式 %s 啟動，監看 %s", VERSION, up.cfg.watch_dir)
    if a.once:
        up.tick()   # 第一輪只記檔案大小
        time.sleep(1)
        up.run(once=True)
    elif a.no_tray:
        up.run()
    else:
        run_tray(up)


if __name__ == "__main__":
    main()
