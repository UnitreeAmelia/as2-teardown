#!/bin/zsh
# AS2 结构拆装实训 — 本地启动
# 双击即可。起一个静态服务并打开浏览器。
cd "$(dirname "$0")" || exit 1

PORT=8125
URL="http://127.0.0.1:$PORT/"

# 端口已被占用就直接开浏览器（通常是上次没关）
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在运行：$URL"
  open "$URL"
  exit 0
fi

echo "启动本地服务 $URL"
echo "关闭这个窗口或按 Ctrl+C 结束。"
echo

python3 -m http.server $PORT >/dev/null 2>&1 &
SERVER_PID=$!

sleep 1
open "$URL"

# 前台等待，Ctrl+C 时连带关掉 python
trap 'kill $SERVER_PID 2>/dev/null; echo; echo "服务已停止"; exit 0' INT TERM
wait $SERVER_PID 2>/dev/null
