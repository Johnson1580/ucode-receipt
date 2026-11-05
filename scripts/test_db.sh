#!/bin/bash
# 用本機暫時的 PostgreSQL 測 migration 與權限（不碰正式資料庫）。需要 brew install postgresql@17
set -e
export LC_ALL=C LANG=C  # 沒設會出現 postmaster became multithreaded
PG=/usr/local/opt/postgresql@17/bin; [ -d "$PG" ] || PG=/opt/homebrew/opt/postgresql@17/bin
DIR=$(mktemp -d /tmp/pgt.XXXX); PORT=54329  # socket 路徑不能太長
trap '$PG/pg_ctl -D "$DIR" stop -m fast >/dev/null 2>&1; rm -rf "$DIR"' EXIT
$PG/initdb -D "$DIR" -U postgres --locale=C -E UTF8 -A trust >/dev/null 2>&1
$PG/pg_ctl -D "$DIR" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
cd "$(dirname "$0")/.."
PSQL="$PG/psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do
  if grep -q "local-test: skip" "$f"; then echo "略過 $f"; continue; fi
  echo "套用 $f"; $PSQL -f "$f"
done
$PSQL -o /dev/null -f supabase/tests/flows.sql
