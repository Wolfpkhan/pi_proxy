# pi-proxy

[中文](#中文) | [English](#english)

Wraps the agent capabilities of [pi](https://github.com/mariozechner/pi-coding-agent) (tool calls, skills, sessions) into an **OpenAI-compatible API** — so any OpenAI client gets a full local agent behind `POST /v1/chat/completions`. Built as the LLM backend of my [sherpa voice assistant](https://github.com/Wolfpkhan/voice_assistant) on Android/Termux.

> 🔌 **The protocol is open — pi-proxy is just one reference implementation.** If it doesn't fit your stack, implement your own proxy in any language following [PROTOCOL.md](./PROTOCOL.md): a minimal compatible proxy is ~150 lines. See the implementation checklist below (English section).

> 🙏 **Special thanks to the [pi project](https://github.com/mariozechner/pi-coding-agent)** ([mariozechner](https://github.com/mariozechner)) — this proxy is a thin OpenAI-compatible shell over pi's agent loop. All the real capabilities (tool calling, skills, sessions, compaction, multi-provider auth) come from pi. Without it, none of this exists.

---

## 中文

把 [pi](https://github.com/mariozechner/pi-coding-agent) 的 agent 能力（工具调用、技能、会话）包装成 **OpenAI 兼容 API**——任何 OpenAI 客户端指向它，就获得一个能在 Termux 里跑工具、带持久会话的本地 agent。它是我的 [sherpa 语音助手](https://github.com/Wolfpkhan/voice_assistant)的 LLM 后端。

> 🔌 **协议是开放的——pi-proxy 只是参考实现之一。** 不适合你的技术栈？用任何语言按 [PROTOCOL.md](./PROTOCOL.md) 自行实现一个兼容代理即可（最小实现约 150 行），见下方[接口清单](#实现你自己的兼容代理)。App/客户端不绑定本实现。

> 🙏 **特别感谢 [pi 项目](https://github.com/mariozechner/pi-coding-agent)**（[mariozechner](https://github.com/mariozechner)）——本代理只是套在 pi agent loop 外面的一层薄薄的 OpenAI 兼容外壳。真正的能力全部来自 pi：工具调用、技能、会话持久化、compaction、多 provider 模型接入。没有 pi，就没有这个项目。

### 原理

```
任意 OpenAI 客户端 (App LlmClient / curl / ...)
        ↓ http://127.0.0.1:8988/v1/chat/completions
   pi-proxy.mjs (本服务，OpenAI SSE)
        ↓ createAgentSession + subscribe
      pi agent loop
   ├─ 工具调用 (read/bash/edit/grep...)  ← tool_calls 增量透传 + 执行注释行
   ├─ 技能/扩展自动发现
   └─ text_delta / reasoning 事件
        ↓ 转成 OpenAI SSE
      客户端收到 → 流式渲染 / TTS 播报
```

客户端**零改动**：任何 OpenAI 兼容客户端把 `baseUrl` 换成 `http://127.0.0.1:8988/v1` 即可。

### 特性

- **复用 pi agent loop**：工具调用、会话持久化、compaction 全继承
- **tool_calls 增量透传**：OpenAI 标准 delta.tool_calls 格式；工具执行开始/结束以 SSE 注释行透传（标准客户端自动忽略，需要可见性的客户端单独解析）
- **finish_reason + usage 终帧**：来源是 pi 的 `message_end`（role=assistant）
- **断连即中断**：客户端断开 SSE（未完成）→ 自动 `session.abort()`，完全 OpenAI 标准语义
- **图片附件**：多模态 content（`image_url`，data URL 或 http URL）。默认 `materialize` 模式：图片落盘为文件 + 在 prompt 里告知路径并提示 agent 用 `mmx vision describe` 识图——**不依赖 vision LLM**；也可切 `passthrough` 透传给 vision LLM
- **多模型**：config 指定 provider/model（走 pi 的模型注册，llm-wire/deepseek/minimax 等任选）
- **专用工作目录**：agent 的 read/bash 作用域可配置（`cwd`）

### 实现你自己的兼容代理

客户端（App）只认 **OpenAI 兼容接口**，不绑定 pi-proxy。任何语言、任何后端（另一个 agent 框架、自家微服务、甚至直接包一个云端 vision LLM）只要实现以下接口即可无缝替换：

| 接口 | 必要性 | 说明 |
|------|--------|------|
| `POST /v1/chat/completions`（`stream:true`，SSE） | ★ 必须 | 核心端点。首帧 `role:assistant` 立即发；增量 `delta.content`；终帧 `finish_reason` + `[DONE]` |
| `GET /v1/models` | ★ 必须 | 连通性探测，返回模型列表 JSON |
| 断连即中断 | ★ 必须 | 客户端断开 SSE → 停止生成/abort 后端（OpenAI 官方语义，否则残留运行中的 agent 会阻塞下一请求） |
| 错误格式 | ★ 必须 | `{"error":{"message","type","code"}}` + 标准状态码 |
| `POST /v1/new-session` | ⚡ 扩展（推荐） | App 点「新对话」时调用；不支持则返回 404，App 静默忽略（无 session 概念的服务端不需要） |
| `delta.reasoning_content` | ○ 可选 | 思考链流式；App 渲染为可折叠的思考区 |
| `delta.tool_calls`（增量） | ○ 可选 | 工具调用可视化；首帧带 `id`/`name`，后续 `arguments` 增量 |
| SSE 注释行 `: [tool_start]` / `: [tool_end]` | ○ 可选 | 工具执行状态反馈；标准 OpenAI 客户端自动忽略，不影响兼容性 |
| 多模态 content（`image_url`） | ○ 可选 | 图片附件：data URL 或 http URL，客户端已压缩好 |

完整规范（帧格式、测试清单、设计动机）见 **[PROTOCOL.md](./PROTOCOL.md)**。最小实现参考：

- 输入：取 `messages` 里最后一条 user 消息作为新 prompt（服务端自管历史）
- 输出：`role` 首帧 → `content` 增量帧 → `finish_reason` 终帧 → `[DONE]`
- 流式响应加 `Cache-Control: no-cache` + `x-accel-buffering: no`（防反代缓冲）

### 使用

```bash
# 1. 前置：Termux 里已装 pi（@mariozechner/pi-coding-agent）并配好模型 auth
# 2. 启动服务
cd ~/code/pi-proxy
bash start-pi-proxy.sh

# 3. 客户端 baseUrl 指向 http://127.0.0.1:8988/v1
```

配置 `config.json`：

```jsonc
{
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls", "cron"],
  "model": { "provider": "llm-wire", "id": "minimax/minimax-m3" },
  "server": { "host": "127.0.0.1", "port": 8988 },
  "cwd": "~/code/voice-assistant-workspace",
  "images": {
    "mode": "materialize",
    "dir": "/data/data/com.termux/files/usr/tmp/pi-proxy-images",
    "hintSingle": "\n\n🖼️ ATTACHED: {path}\n→ mmx vision describe --image {path}"
  }
}
```

### 验证

```bash
# 健康检查 / 模型列表
curl http://127.0.0.1:8988/v1/models

# 流式对话（带工具）
curl -N http://127.0.0.1:8988/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"读一下 memo.txt"}]}'

# 多模态（图片识图）
curl -N http://127.0.0.1:8988/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":[
    {"type":"text","text":"这张图是什么"},
    {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}]}]}'

# 新会话（可选扩展端点，标准客户端忽略）
curl -X POST http://127.0.0.1:8988/v1/new-session

# 日志
tail -f ~/pi-proxy.log
```

### 让 agent 操作文件（工具用例）

工作目录 `cwd` 是 agent 的 read/bash 作用域。往里面放文件，agent 就能读取/操作：

```bash
echo "备忘：明天开会" > ~/code/voice-assistant-workspace/memo.txt
# 然后语音问："我的备忘录写了什么" → agent 用 read 工具读取并回答
```

### 文件说明

- `pi-proxy.mjs` — 主服务（~530 行，零依赖，仅 Node 内置 http + pi SDK）
- `PROTOCOL.md` — 客户端兼容协议规范（SSE 帧格式、tool_calls、注释行、扩展端点）
- `start-pi-proxy.sh` — 启动脚本（含日志重定向）
- `config.json` — 运行配置（工具白名单/模型/端口/images 策略）

---

## English

Wraps [pi](https://github.com/mariozechner/pi-coding-agent)'s agent capabilities (tool calls, skills, sessions) into an **OpenAI-compatible API** — point any OpenAI client at it and you get a full local agent running tools in Termux, with persistent sessions. It's the LLM backend of my [sherpa voice assistant](https://github.com/Wolfpkhan/voice_assistant) on Android.

### How It Works

```
Any OpenAI client (app LlmClient / curl / ...)
        ↓ http://127.0.0.1:8988/v1/chat/completions
   pi-proxy.mjs (this service, OpenAI SSE)
        ↓ createAgentSession + subscribe
      pi agent loop
   ├─ tool calls (read/bash/edit/grep...)  ← streamed as delta.tool_calls + exec comment lines
   ├─ skills/extensions auto-discovery
   └─ text_delta / reasoning events
        ↓ converted to OpenAI SSE
      client renders streaming / speaks via TTS
```

Zero client changes: any OpenAI-compatible client just sets `baseUrl` to `http://127.0.0.1:8988/v1`.

### Features

- **Full pi agent loop**: tool calls, session persistence, compaction — all inherited
- **tool_calls streaming**: standard OpenAI `delta.tool_calls` format; tool exec start/end as SSE comment lines (standard clients ignore them; visibility-aware clients parse them)
- **finish_reason + usage final frame**: sourced from pi's `message_end` (role=assistant)
- **Disconnect = abort**: an unfinished SSE disconnect triggers `session.abort()` — pure OpenAI semantics
- **Image attachments**: multimodal content (`image_url`, data URL or http URL). Default `materialize` mode saves images to files and hints the agent to use `mmx vision describe` — **no vision LLM required**; switch to `passthrough` to forward to a vision LLM
- **Any model**: provider/model set in config (via pi's registry — llm-wire/deepseek/minimax...)
- **Sandboxed workspace**: agent read/bash scope configurable via `cwd`

### Implement Your Own Compatible Proxy

The client (the app) only speaks the **OpenAI-compatible interface** — it is not tied to pi-proxy. Any language, any backend (another agent framework, your own microservice, or even a plain wrapper over a cloud LLM) can be a drop-in replacement as long as it implements:

| Interface | Required? | Notes |
|---|---|---|
| `POST /v1/chat/completions` (`stream:true`, SSE) | ★ required | The core endpoint. Send `role:assistant` immediately; stream `delta.content`; end with `finish_reason` + `[DONE]` |
| `GET /v1/models` | ★ required | Connectivity probe, returns a model list JSON |
| Disconnect = abort | ★ required | Client SSE disconnect → stop generation / abort the backend (official OpenAI semantics; otherwise a leftover agent run blocks the next request) |
| Error format | ★ required | `{"error":{"message","type","code"}}` + standard status codes |
| `POST /v1/new-session` | ⚡ extension (recommended) | Fired when the user taps “New chat”; return 404 if unsupported — the client silently ignores it (stateless servers don't need it) |
| `delta.reasoning_content` | ○ optional | Chain-of-thought streaming; rendered as a collapsible thinking section |
| `delta.tool_calls` (incremental) | ○ optional | Tool-call visualization; first frame carries `id`/`name`, later frames carry `arguments` deltas |
| SSE comment lines `: [tool_start]` / `: [tool_end]` | ○ optional | Tool execution status; standard OpenAI clients ignore them automatically |
| Multimodal content (`image_url`) | ○ optional | Image attachments: data URL or http URL, already compressed by the client |

Full spec (frame formats, testing checklist, design rationale): **[PROTOCOL.md](./PROTOCOL.md)**. Minimal-implementation notes:

- Input: take the last `user` message as the new prompt (the server manages its own history)
- Output: `role` first frame → incremental `content` frames → `finish_reason` final frame → `[DONE]`
- Add `Cache-Control: no-cache` + `x-accel-buffering: no` to streaming responses (prevents reverse-proxy buffering)

### Usage

```bash
# 1. Prereq: pi (@mariozechner/pi-coding-agent) installed in Termux with model auth configured
# 2. Start the service
cd ~/code/pi-proxy
bash start-pi-proxy.sh

# 3. Point your client's baseUrl at http://127.0.0.1:8988/v1
```

See the `config.json` sample above (Chinese section) for tool whitelist, model, server, cwd and image policy.

### Verify

```bash
curl http://127.0.0.1:8988/v1/models

curl -N http://127.0.0.1:8988/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"read memo.txt"}]}'
```

### Files

- `pi-proxy.mjs` — the service (~530 lines, zero deps beyond Node builtins + pi SDK)
- `PROTOCOL.md` — client compatibility spec (SSE frames, tool_calls, comment lines, extension endpoints)
- `start-pi-proxy.sh` — start script (with log redirection)
- `config.json` — runtime config (tools/model/port/images policy)
