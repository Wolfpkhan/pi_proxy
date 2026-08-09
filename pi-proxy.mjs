#!/usr/bin/env node
/**
 * pi-proxy.mjs — 把 pi 的 agent 能力包装成 OpenAI 兼容 API。
 *
 * 给 sherpa 语音助手用：App 的 LlmClient（OpenAI 兼容 SSE 客户端）无需改动，
 * 只需把 baseUrl 指向本服务（默认 http://127.0.0.1:8988/v1）。
 *
 * 特性：
 *   • 复用 pi 的 agent loop：工具调用(read/bash/edit/grep/...)、技能、会话持久化、compaction 全继承
 *   • 单长期会话（语音助手 = 单人连续对话）
 *   • 工具调用静默执行（pi 内部照常多轮调工具，但只把最终文本 text_delta 转 SSE 给 App）
 *   • 固定模型：llm-wire 的 deepseek/deepseek-v4-flash
 *   • 固定工作目录：~/code/voice-assistant-workspace（agent 的 read/bash 作用域）
 *
 * 协议：OpenAI /v1/chat/completions (stream=true)
 *   请求里只取 messages 最后一条 user 的 content 作为 prompt；
 *   其余字段（model/temperature 等）忽略，用 pi 配置。
 *
 * 启动：node pi-proxy.mjs
 */

import http from "node:http";
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 8988;
const HOST = "127.0.0.1";
const CWD = join(homedir(), "code", "voice-assistant-workspace");
const TARGET_MODEL = { provider: "llm-wire", id: "deepseek/deepseek-v4-flash" };

// ---------- 1. pi agent 会话管理（默认 continueRecent，可手动新对话） ----------
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const TARGET_MODEL_OBJ = modelRegistry.find(TARGET_MODEL.provider, TARGET_MODEL.id);
if (!TARGET_MODEL_OBJ) {
	console.error(`[pi-proxy] 找不到模型 ${TARGET_MODEL.provider}/${TARGET_MODEL.id}`);
	process.exit(1);
}

let session;
let unsubscribeActive = null;  // 当前会话的事件订阅（重建时先取消）

/** (重新)创建会话。newOne=true 开新 session，否则 continueRecent 接着最近会话。 */
async function initSession(newOne = false) {
	// 取消旧会话订阅并释放
	if (unsubscribeActive) { try { unsubscribeActive(); } catch {} unsubscribeActive = null; }
	if (session) { try { session.dispose(); } catch {} }
	const res = await createAgentSession({
		model: TARGET_MODEL_OBJ,
		cwd: CWD,
		// 保留完整工具集：agent 能 read/bash/edit/grep 等，可搜历史 session 文件
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		authStorage,
		modelRegistry,
		// ★ 持久化：默认接着最近会话（continueRecent）；新对话用 create
		sessionManager: newOne ? SessionManager.create(CWD) : SessionManager.continueRecent(CWD),
	});
	session = res.session;
	console.error(`[pi-proxy] 会话就绪(${newOne ? "新对话" : "接着最近"}): ${session.sessionId}, file=${session.sessionFile ?? "(无)"}`);
}

// 启动时创建会话
try {
	await initSession(false);
} catch (e) {
	console.error(`[pi-proxy] 初始化失败: ${e.message}`);
	process.exit(1);
}

// ---------- 2. OpenAI 兼容 SSE 响应 ----------
function sseChunk(delta) {
	// OpenAI chat.completion.chunk 格式
	const payload = {
		id: "chatcmpl-pi",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "deepseek-v4-flash",
		choices: [{
			index: 0,
			delta: delta === null ? { role: "assistant" } : { content: delta },
			finish_reason: null,
		}],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";

/** 处理一次 /v1/chat/completions 请求：把 OpenAI messages → pi prompt，pi 事件 → OpenAI SSE。 */
async function handleChat(res, body) {
	// 取最后一条 user content 作为 prompt（pi 单会话自己管历史）
	let userText = "";
	try {
		const msgs = body.messages || [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === "user") { userText = typeof msgs[i].content === "string" ? msgs[i].content : ""; break; }
		}
	} catch {}
	if (!userText) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "messages 中无 user content" } }));
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		"connection": "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write(sseChunk(null)); // 首帧 role:assistant
	console.error(`[pi-proxy] 收到请求 (prompt 长度=${userText.length}): "${userText.slice(0, 40)}"`);

	// 订阅 pi 事件：只转 text_delta（工具调用静默）
	let unsubscribe = session.subscribe((event) => {
		try {
			if (event.type === "message_update") {
				const ae = event.assistantMessageEvent;
				if (ae && ae.type === "text_delta" && ae.delta) {
					res.write(sseChunk(ae.delta));
				}
				// tool_execution_* / thinking_* 等事件全部静默忽略
			} else if (event.type === "agent_end") {
				res.write(SSE_DONE);
				res.end();
				if (unsubscribe) { unsubscribe(); unsubscribe = null; }
			} else if (event.type === "extension_error") {
				console.error("[pi-proxy] 扩展错误:", event);
			}
		} catch (e) {
			console.error("[pi-proxy] 事件处理异常:", e.message);
		}
	});

	try {
		await session.prompt(userText);
	} catch (e) {
		console.error("[pi-proxy] prompt 失败:", e.message);
		// 把错误作为一段文本吐出，保证流闭合
		res.write(sseChunk(`（出错：${e.message}）`));
		res.write(SSE_DONE);
		res.end();
	} finally {
		if (unsubscribe) { unsubscribe(); unsubscribe = null; }
	}
}

// ---------- 3. HTTP server ----------
const server = http.createServer(async (req, res) => {
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-headers", "*");
	res.setHeader("access-control-allow-methods", "*");
	if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

	// 健康检查 / 模型列表（让 App 的连通性探测能通过）
	if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({
			object: "list",
			data: [{ id: "deepseek-v4-flash", object: "model", owned_by: "pi-proxy" }],
		}));
		return;
	}

	// chat completions
	if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		let body;
		try { body = JSON.parse(raw); }
		catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "JSON 解析失败" } }));
			return;
		}
		await handleChat(res, body);
		return;
	}

	// ★ 新对话：重建 session（新 session 文件，旧会话保留供 grep 检索）
	if (req.method === "POST" && (req.url === "/v1/new-session" || req.url === "/new-session")) {
		try {
			await initSession(true);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, sessionId: session.sessionId }));
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: e.message } }));
		}
		return;
	}

	// 其它路径：简单 404
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: `Not Found: ${req.url}` } }));
});

server.on("error", (e) => {
	if (e.code === "EADDRINUSE") {
		console.error(`[pi-proxy] 端口 ${PORT} 被占，1秒后重试...`);
		setTimeout(() => server.listen(PORT, HOST), 1000);
	} else {
		console.error("[pi-proxy] server 错误:", e);
	}
});
server.listen(PORT, HOST, () => {
	console.error(`[pi-proxy] OpenAI 兼容服务已启动: http://${HOST}:${PORT}/v1`);
	console.error(`[pi-proxy] → App 设置 baseUrl = http://${HOST}:${PORT}/v1`);
});

// 优雅退出
function shutdown(reason = "") {
	const stk = reason ? "\n" + new Error().stack : "";
	console.error(`[pi-proxy] 关闭中 (${reason})${stk}`);
	try { session.dispose(); } catch {}
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
// ★ Termux 环境下常有 SIGTERM 打捷（logcat/am/其他守护），proxy 作为长服务必须无视 SIGTERM
process.on("SIGTERM", () => console.error("[pi-proxy] 收到 SIGTERM，忽略（长服务保活，用 SIGINT 或 kill -9 退出）"));
// 后台运行时忽略 SIGHUP（父 shell 退出时不杀子进程）
process.on("SIGHUP", () => console.error("[pi-proxy] 收到 SIGHUP，忽略（后台保活）"));
// 捕获未处理异常，避免静默退出
process.on("uncaughtException", (e) => console.error("[pi-proxy] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[pi-proxy] unhandledRejection:", e));
