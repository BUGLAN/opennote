#!/usr/bin/env bash
# ============================================================================
# jump-probe — 一键重跑
#
#   bash .tmp-verify/jump-probe/run.sh            # 全部场景
#   bash .tmp-verify/jump-probe/run.sh A B        # 只跑指定场景
#
# 产物：.tmp-verify/jump-probe/out/*.json（原始 JSON）+ 终端摘要
# 前提：仓库根目录已安装依赖（node_modules 在）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT=5199
CDP=9222
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="$HERE/chrome-profile"
URL="http://127.0.0.1:$PORT/.tmp-verify/jump-probe/index.html"

cd "$ROOT"
mkdir -p "$HERE/out"

WANT=("$@")
want() { [ ${#WANT[@]} -eq 0 ] && return 0; for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

# ---------------------------------------------------------------- vite
if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "[run] vite 已在 $PORT 上运行，复用"
else
  echo "[run] 启动 vite ..."
  nohup npx vite --config "$HERE/vite.config.mts" > "$HERE/vite.log" 2>&1 &
  for i in $(seq 1 40); do
    sleep 1
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  done
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" || { echo "[run] vite 起不来，看 $HERE/vite.log"; exit 1; }
fi

# ---------------------------------------------------------------- chrome
echo "[run] 启动 Chrome headless ..."
taskkill //F //IM chrome.exe >/dev/null 2>&1
sleep 2
rm -rf "$PROFILE"; mkdir -p "$PROFILE"
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --remote-debugging-port=$CDP \
  --user-data-dir="$(cygpath -w "$PROFILE")" \
  --no-first-run --no-default-browser-check --disable-extensions \
  --window-size=1280,2900 \
  "$URL" > "$HERE/chrome.log" 2>&1 &
for i in $(seq 1 30); do
  sleep 1
  curl -s "http://127.0.0.1:$CDP/json/list" | grep -q '"type": "page"' && break
done
sleep 4

CDP_NODE=(node "$HERE/cdp.mjs" $CDP)

# ---------------------------------------------------------------- scenarios
run_scenario() { # $1 = name, $2 = expression
  local name="$1" expr="$2"
  want "$name" || return 0
  echo "[run] $name ..."
  "${CDP_NODE[@]}" "$expr" --out "$HERE/out/$name.json" >/dev/null 2>"$HERE/out/$name.err" \
    || { echo "[run] $name 失败："; cat "$HERE/out/$name.err"; return 1; }
  "${CDP_NODE[@]}" "location.reload(); return 1" >/dev/null 2>&1
  sleep 5
}

run_scenario A "return await PROBE.runA()"
run_scenario B "return await PROBE.runB()"
run_scenario C "return await PROBE.runC()"
run_scenario D "return await PROBE.runD()"
run_scenario E "return await PROBE.runE()"

if want trace-scrolltop; then
  echo "[run] trace-scrolltop ..."
  "${CDP_NODE[@]}" "$HERE/measure/trace-scrolltop.js" --file --out "$HERE/out/trace-scrolltop.json" >/dev/null 2>&1
  "${CDP_NODE[@]}" "location.reload(); return 1" >/dev/null 2>&1; sleep 5
fi
if want trace-anchor; then
  echo "[run] trace-anchor ..."
  "${CDP_NODE[@]}" "$HERE/measure/trace-anchor.js" --file --out "$HERE/out/trace-anchor.json" >/dev/null 2>&1
fi

# ---------------------------------------------------------------- summary
echo
node "$HERE/summary.mjs"

echo
echo "[run] 原始 JSON 在 $HERE/out/"
echo "[run] Chrome 仍在运行（CDP $CDP）。收工：taskkill //F //IM chrome.exe"
