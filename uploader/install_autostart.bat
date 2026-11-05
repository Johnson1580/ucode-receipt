@echo off
chcp 65001 >nul
rem 開機登入後自動執行上傳程式（Windows 工作排程器）。在 uploader.exe 所在資料夾執行。
rem 工作名稱用英文：命令列編碼不同時中文名稱可能變亂碼。
schtasks /Create /F /TN "UCode-Receipt-Uploader" /SC ONLOGON /RL LIMITED /TR "\"%~dp0uploader.exe\""
echo 已設定開機自動執行（工作排程器：UCode-Receipt-Uploader）
pause
