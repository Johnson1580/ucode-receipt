#!/bin/bash
# 把 GitHub Actions 打包好的 uploader.exe 放上雲端（uploader bucket），常駐電腦的上傳程式 6 小時內會自動更新。
# 用法：./scripts/publish_uploader.sh [run id]（不給就用 uploader-windows 最近一次成功的）
# 版本號取該次打包的 commit 裡 uploader.py 的 VERSION；要比常駐電腦上的新才會更新。
set -e
cd "$(dirname "$0")/.."
PROJECT_REF="（填本專案的 Supabase ref）"   # 建好 Supabase 專案後填入，避免發布到別的專案
[ "$(cat supabase/.temp/project-ref 2>/dev/null)" = "$PROJECT_REF" ] || { echo "supabase/.temp/project-ref 不是本專案，停止"; exit 1; }
RUN=${1:-$(gh run list --workflow uploader.yml --status success -L 1 --json databaseId -q '.[0].databaseId')}
SHA_COMMIT=$(gh run view "$RUN" --json headSha -q .headSha)
VER=$(git show "$SHA_COMMIT:uploader/uploader.py" | sed -n 's/^VERSION = "\(.*\)"/\1/p')
DIR=$(mktemp -d)
gh run download "$RUN" -n uploader-windows -D "$DIR"
SUM=$(shasum -a 256 "$DIR/uploader.exe" | cut -d' ' -f1)
FILE="uploader-$VER.exe"
printf '{"version":"%s","sha256":"%s","file":"%s"}\n' "$VER" "$SUM" "$FILE" > "$DIR/latest.json"
echo "發布 $FILE（run $RUN，commit ${SHA_COMMIT:0:7}，sha256 ${SUM:0:12}…）"
SB="npx supabase@2.119.0 --experimental"
$SB storage cp "$DIR/uploader.exe" "ss:///uploader/$FILE" --linked --content-type application/octet-stream
$SB storage rm "ss:///uploader/latest.json" --linked --yes >/dev/null 2>&1 || true
$SB storage cp "$DIR/latest.json" "ss:///uploader/latest.json" --linked --content-type application/json --cache-control no-cache
echo "完成：常駐電腦 6 小時內會自動更新到 $VER（工作列圓點滑過去看版本，或看處理總覽）"
