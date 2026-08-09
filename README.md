# pi-proxy

把 [pi](https://github.com/mariozechner/pi-coding-agent) 的 agent 能力（工具调用、技能、会话）包装成 **OpenAI 兼容 API**，供 sherpa 语音助手接入。

## 原理

```
App LlmClient (OpenAI兼容SSE)
        ↓ http://127.0.0.1:8988/v1
   pi-proxy.mjs (本服务)
        ↓ createAgentSession + subscribe
      pi agent loop
   ├─ 工具调用 (read/bash/edit/grep...)  ← 静默执行
   ├─ 技能/扩展自动发现
   └─ text_delta 事件
        ↓ 转成 OpenAI SSE
      App 收到 → TTS 播报
```

App 端**零逻辑改动**：现在的 `LlmClient` 本就是 OpenAI 兼容客户端，只需在设置页把 `baseUrl` 换成 `http://127.0.0.1:8988/v1`。

## 特性

- **复用 pi agent loop**：工具调用、会话持久化、compaction 全继承
- **工具静默**：agent 多轮调工具（read/bash 等），但 SSE 只输出最终文本
- **单长期会话**：适合语音助手连续对话
- **固定模型**：`llm-wire/deepseek/deepseek-v4-flash`
- **专用工作目录**：`~/code/voice-assistant-workspace`（agent 的 read/bash 作用域）

## 使用

```bash
# 1. 启动服务
cd ~/code/pi-proxy
bash start-pi-proxy.sh

# 2. App 设置 → baseUrl 改成 http://127.0.0.1:8988/v1
# 3. 开始对话，agent 会带工具能力回答
```

## 验证

```bash
# 健康检查
curl http://127.0.0.1:8988/v1/models

# 流式对话
curl -N http://127.0.0.1:8988/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"读一下test.txt"}]}'

# 日志
tail -f ~/pi-proxy.log
```

## 让 agent 操作文件（工具用例）

工作目录 `~/code/voice-assistant-workspace` 是 agent 的 read/bash 作用域。往里面放文件，agent 就能读取/操作：

```bash
echo "备忘：明天开会" > ~/code/voice-assistant-workspace/memo.txt
# 然后语音问："我的备忘录写了什么" → agent 会 read 工具读取并回答
```

## 文件说明

- `pi-proxy.mjs` — 主服务（~170 行，零依赖，仅用 Node 内置 http + pi SDK）
- `start-pi-proxy.sh` — 启动脚本
- `node_modules/@mariozechner/*` — 软链到全局 pi 包（ESM 解析所需）
