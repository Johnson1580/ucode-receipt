@echo off
chcp 65001 >nul
rem 在 Windows 打包成單一執行檔 dist\uploader.exe（需要先安裝 Python 3.12 以上）
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt pyinstaller==6.16.0
.venv\Scripts\pyinstaller --onefile --noconsole --name uploader uploader.py
echo 完成：dist\uploader.exe，與 config.json 放在同一個資料夾
