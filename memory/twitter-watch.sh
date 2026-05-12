#!/bin/bash
# 监听 Bunny 新推文，有新推文时立即触发同步
# 每2分钟检查一次最新推文ID，与数据库比对

SYNC_CMD="/usr/bin/node /root/memory/sync-twitter.js"
SYNC_LOG="/var/log/memory-palace-sync.log"
DB="/root/memory/palace.db"
INTERVAL=120

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "twitter-watch 启动，检查间隔 ${INTERVAL}s"

while true; do
  # 获取 bb-browser 返回的最新推文 ID
  LATEST_REMOTE=$(bb-browser site twitter/tweets bunnyloustin 3 2>/dev/null \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    tweets = d.get('tweets', [])
    print(tweets[0]['id'] if tweets else '')
except Exception:
    print('')
" 2>/dev/null)

  if [ -z "$LATEST_REMOTE" ]; then
    log "警告：无法获取最新推文 ID，跳过本次检查"
    sleep $INTERVAL
    continue
  fi

  # 检查该推文是否已在数据库中
  EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entries WHERE source_hash='tweet:${LATEST_REMOTE}'")

  if [ "$EXISTS" -eq 0 ]; then
    log "★ 发现新推文 ID:${LATEST_REMOTE}，立即触发同步..."
    $SYNC_CMD >> "$SYNC_LOG" 2>&1
    log "同步完成"
  else
    log "无新推文（最新 ID: ${LATEST_REMOTE}）"
  fi

  sleep $INTERVAL
done
