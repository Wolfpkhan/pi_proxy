# Agent Proxy Protocol — Implementing a Compatible LLM Proxy

This document specifies how to implement an **OpenAI-compatible + agent-capable**
LLM proxy service that works fully with Argus (and any other client expecting
OpenAI Chat Completions API).

The reference implementation is **[pi-proxy](./pi-proxy.mjs)** (Node.js +
the [pi](https://github.com/badlogic/pi-mono) coding agent).

---

## TL;DR

To be Argus-compatible you need:

| Requirement | Section | Mandatory? |
|---|---|---|
| `GET /v1/models` | §1.1 | ✓ required |
| `POST /v1/chat/completions` (SSE) | §1.2 | ✓ required |
| Client-disconnect = abort generation | §2 | ✓ required |
| `POST /v1/new-session` | §3 | ⚡ extension (graceful 404 OK) |
| `reasoning_content` field | §4.1 | ○ optional |
| `tool_calls` streaming | §4.2 | ○ optional |
| `: [tool_start]` / `[tool_end]` SSE comments | §4.3 | ○ optional |

A **minimal proxy is ~150 lines**. A full agent loop with tools is more, but
the protocol surface stays the same.

---

## 1. OpenAI Standard — Required

### 1.1 `GET /v1/models`

Return a model list. Argus uses this for connectivity probing.

```json
{
  "object": "list",
  "data": [
    {"id": "your-model-id", "object": "model", "owned_by": "you"}
  ]
}
```

You may return 1 model (the active one) or many.

### 1.2 `POST /v1/chat/completions`

This is the main endpoint. Argus sends standard OpenAI-format requests:

```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user",   "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "stream": true
}
```

**Behavior contract**:

- **Input parsing**: Read `messages` array; pick the **last user message** as
  the new prompt. Other messages may be ignored (your proxy manages its own
  session history) or honored (if you implement stateless OpenAI semantics).
- **Streaming**: Must return `text/event-stream`.
- **First frame**: `data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}` — send this immediately so the client can render "thinking".
- **Content frames**: `data: {"choices":[{"index":0,"delta":{"content":"..."}}]}`
- **Finish frame**: `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`
- **Done**: `data: [DONE]`

You may also implement non-streaming (`"stream": false`) — Argus sets `stream=true`
but a graceful fallback to a single JSON response is acceptable.

---

## 2. Disconnect = Abort — Required

**OpenAI official semantics**: when the client closes the HTTP connection,
the server **must stop generation and abort the underlying computation**.

```js
// Node.js reference
res.on("close", () => {
    if (!finished && agent.abort) {
        try { agent.abort(); } catch {}
    }
});
```

**Why mandatory**: without this, a client disconnect (user taps "stop",
network drops, app killed) leaves the server-side agent still running,
possibly calling tools, consuming tokens, and blocking subsequent requests
("Agent is already processing" errors).

**How to test**:

```bash
# Start a long generation, force disconnect after 2s
curl -s -N --max-time 2 -X POST .../v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"write a 5000-word essay"}],"stream":true}' \
  > /dev/null
# Server log should show: "client disconnected → abort"
```

Use `res.on('close')` on the response, **not** `req.on('aborted')` — the
latter doesn't reliably fire under all HTTP frameworks (Express/Koa/uvicorn).

---

## 3. Session Reset — Extension (Optional but Recommended)

### 3.1 `POST /v1/new-session`

Argus fires this when the user taps the **"新对话"** (New Chat) button.

**Semantics**: discard/close the current server-side session, create a new
empty one. Subsequent `chat/completions` calls go to the new session.

**Response**:

```json
{"ok": true, "sessionId": "..."}
```

`sessionId` is optional — Argus does not parse it.

### 3.2 If you don't support session management

Return `404 Not Found` with a standard error body. Argus silently ignores.

This is the right behavior for stateless OpenAI-compatible services — Argus
manages its own `messages[]` history on the client side, which works perfectly
without server-side sessions.

---

## 4. Optional Enhancements

These add features that Argus surfaces in its UI. Skip any that you don't need.

### 4.1 Reasoning content (`reasoning_content` field)

For chain-of-thought models (DeepSeek-R1, OpenAI o1, etc.):

```json
{"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}
```

Argus renders this in a collapsible "thinking" section above the answer.

**Important**: `reasoning_content` and `content` are independent — you can
emit them in any order, interleaved, or one without the other.

### 4.2 Tool calls streaming

Implement the full OpenAI tool_calls streaming protocol if your agent
uses tools:

```json
// First frame for a call:
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"bash"}}]}}]}

// Arguments delta:
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"curl "}}]}}]}

// End of call (finish_reason indicates tool_calls):
{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

Argus parses these and shows a "工具调用" pill in the message bubble.

### 4.3 SSE comment lines — tool execution status

For richer UI feedback, emit **SSE comments** (lines starting with `:`) that
indicate tool execution lifecycle. Standard OpenAI clients ignore them.

```
: [tool_start] bash call_abc
: [tool_end]   bash call_abc 0
```

- `tool_start` fires **before** the tool runs (agent picks tool, args parsed)
- `tool_end` fires **after** it finishes; trailing `0`/`1` = success/error

Argus parses these to show "正在调用 bash..." → "✓ 完成" / "✗ 失败" feedback.

---

## 5. Error Format — Required

Always return OpenAI-style errors:

```json
{"error": {"message": "...", "type": "...", "code": "..."}}
```

Standard HTTP status codes:

| Code | Meaning |
|---|---|
| 400 | Malformed request body |
| 401 | Missing/invalid auth |
| 404 | Unknown path |
| 500 | Internal error (agent crash, tool failure) |
| 503 | Backend model unavailable |

---

## 6. Performance Recommendations

- **First-token latency**: emit the `role:assistant` frame as soon as you
  start the agent run — don't wait for the first token.
- **Bypass header**: `x-accel-buffering: no` on streaming responses
  prevents reverse proxies from buffering.
- **Keepalive**: SSE works fine over HTTP/1.1 keep-alive; no special config.

---

## 7. Reference Implementation

The [pi-proxy](./pi-proxy.mjs) (~400 lines) demonstrates:

- OpenAI Chat Completions streaming (§1)
- Client-disconnect abort (§2)
- `new-session` (§3)
- Tool execution status via SSE comments (§4.3)
- Full pi agent loop integration (tools, thinking, session persistence)

Read it as the canonical reference. The structure is:

```
1. Configuration loading
2. Session manager (create / continue / abort)
3. HTTP server with route dispatch
4. handleChat(): events from agent → SSE chunks to client
```

---

## 8. Testing Checklist

When you've built a proxy, verify each item:

- [ ] `GET /v1/models` returns valid JSON
- [ ] `POST /v1/chat/completions` streams `role:assistant` immediately
- [ ] Content frames arrive incrementally
- [ ] `finish_reason` frame and `[DONE]` both sent
- [ ] Force-disconnect mid-stream → server aborts within 1 second
- [ ] After disconnect, next request succeeds (no "Agent busy" state)
- [ ] `POST /v1/new-session` (if implemented) creates a clean session
- [ ] Argus "新对话" button works end-to-end (UI + history reset)
- [ ] Empty `messages` array → `400 Bad Request` (not crash)

---

## Appendix: Why this protocol?

OpenAI's Chat Completions API is **stateless** by design. For simple
"send a question, get an answer" flows, that's perfect.

For **agent loops** (the model calling tools, iterating, using prior
results), you need **server-side state**. OpenAI Assistants API tries to
solve this with `threads` + `runs`, but it's complex and tied to OpenAI.

This protocol takes the simpler path:

1. Honor OpenAI's standard for the data plane (any client works)
2. Add **one** optional extension (`/v1/new-session`) for stateful servers
3. Use **SSE comments** for agent-specific signals (zero protocol pollution)

Result: 100% OpenAI-compatible on the wire, but agent-aware for clients
that opt in (like Argus).