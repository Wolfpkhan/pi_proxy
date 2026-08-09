#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# start-pi-proxy.sh — 启动 pi-proxy（OpenAI 兼容的 pi agent 服务）
#
# 用 tmux 常驻会话运行（脱离当前 shell 信号，最稳定）。
# 启动后：
#   服务地址: http://127.0.0.1:8988/v1
#   App 设置里把 baseUrl 改成这个即可接入 pi 的 agent 能力（工具调用/会话/技能）
#
# 工作目录: ~/code/voice-assistant-workspace （agent 的 read/bash 作用域）
# 模型: llm-wire 的 deepseek/deepseek-v4-flash
# 会话: 内存单会话（重启即新对话）
#
# 查看: tmux attach -t piproxy   (Ctrl+B D 退出)
# 停止: bash stop-pi-proxy.sh    或  pkill -9 -f pi-proxy.mjs
# ============================================================
set -euo pipefail

SESSION="piproxy"

# 已在运行则提示
if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "✓ pi-proxy 已在运行 (tmux 会话: $SESSION)"
    echo "  服务: http://127.0.0.1:8988/v1"
    echo "  查看: tmux attach -t $SESSION"
    exit 0
fi

echo "启动 pi-proxy (tmux 会话: $SESSION)..."
tmux new-session -d -s "$SESSION" -x 200 -y 50 "node ~/code/pi-proxy/pi-proxy.mjs; echo '=== proxy 已退出，按任意键关闭 ==='; read -n1"
sleep 7

if curl -s -m 3 http://127.0.0.1:8988/v1/models >/dev/null 2>&1; then
    echo "✓ 已启动: http://127.0.0.1:8988/v1"
    echo "  App 设置 → baseUrl = http://127.0.0.1:8988/v1"
    echo "  实时查看: tmux attach -t $SESSION  (Ctrl+B D 退出)"
    echo "  日志文件: tail -f ~/pi-proxy.log"
else
    echo "✗ 启动失败，查看会话:"
    tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -15
    exit 1
fi
