#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# start-pi-proxy.sh — 启动/自愈 pi-proxy（pi agent → OpenAI 兼容服务）
#
# 特性：
#   • 幂等：已在运行则跳过
#   • 等待依赖：llm-wire(8989) 就绪后才启动
#   • 健康检查：启动后轮询 /v1/models 确认可用
#   • wake-lock：防止 Android 休眠冻结
#   • 独立进程组(setsid)：脱离当前 shell 信号，长服务保活
#
# 用法：
#   bash start-pi-proxy.sh        # 手动启动
#   （也由 ~/.termux/boot/start-pi-proxy.sh 开机自启调用）
#
# 服务地址: http://127.0.0.1:8988/v1
# 日志: ~/pi-proxy.log
# 停止: pkill -9 -f pi-proxy.mjs
# ============================================================
set -uo pipefail

# ---------- 从 config.json 读 server.port / server.host（无 jq 依赖，用 node） ----------
# 字段缺失时 fallback 到下方硬编码默认值
PROXY_CONFIG="$HOME/code/pi-proxy/config.json"
PORT=8988
HOST="127.0.0.1"
if [ -f "$PROXY_CONFIG" ] && command -v node >/dev/null 2>&1; then
	read -r _PORT _HOST < <(node -e "
		const cfg = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf-8'));
		const port = (cfg.server && Number.isInteger(cfg.server.port)) ? cfg.server.port : 8988;
		const host = (cfg.server && typeof cfg.server.host === 'string') ? cfg.server.host : '127.0.0.1';
		process.stdout.write(port + ' ' + host);
	" "$PROXY_CONFIG" 2>/dev/null) && [ -n "$_PORT" ] && { PORT="$_PORT"; HOST="$_HOST"; }
fi
echo "[pi-proxy] 使用端口 ${HOST}:${PORT} (来源: $([ -f "$PROXY_CONFIG" ] && echo config.json || echo 默认值))"

PROXY_SCRIPT="$HOME/code/pi-proxy/pi-proxy.mjs"
LOG_FILE="$HOME/pi-proxy.log"
PID_FILE="$HOME/code/pi-proxy/.pi-proxy.pid"

# ---------- 0. 幂等：已在运行则跳过 ----------
if curl -s -m 2 "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
    echo "✓ pi-proxy 已在运行 (端口 $PORT)"
    exit 0
fi

# ---------- 1. 防止 Android 休眠 ----------
termux-wake-lock 2>/dev/null || true

# ---------- 2. 清理残留进程/僵尸 ----------
pkill -9 -f pi-proxy.mjs 2>/dev/null
sleep 1

# ---------- 3. 等待依赖 llm-wire(8989) 就绪（最多 30s） ----------
echo "等待 llm-wire (端口 8989) 就绪..."
for i in $(seq 1 15); do
    if curl -s -m 2 "http://127.0.0.1:8989/v1/models" >/dev/null 2>&1; then
        echo "✓ llm-wire 就绪"
        break
    fi
    [ "$i" -eq 15 ] && { echo "✗ llm-wire 未就绪，pi-proxy 无法启动（先启动 llm-wire）"; exit 1; }
    sleep 2
done

# ---------- 4. 启动 pi-proxy（独立进程组，脱离 shell 信号） ----------
echo "启动 pi-proxy..."
: > "$LOG_FILE"
cd "$(dirname "$PROXY_SCRIPT")"
setsid bash -c "node '$PROXY_SCRIPT' >> '$LOG_FILE' 2>&1" &
PROXY_PID=$!
echo "$PROXY_PID" > "$PID_FILE"

# ---------- 5. 健康检查：轮询 /v1/models（最多 30s） ----------
echo "等待 pi-proxy 就绪..."
for i in $(seq 1 15); do
    if curl -s -m 2 "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
        echo "✓ pi-proxy 已启动: http://$HOST:$PORT/v1 (PID $PROXY_PID)"
        echo "  日志: tail -f $LOG_FILE"
        exit 0
    fi
    sleep 2
done

echo "✗ pi-proxy 启动失败，查看日志: $LOG_FILE"
tail -10 "$LOG_FILE"
exit 1
