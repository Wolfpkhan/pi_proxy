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
 *   • 默认模型：llm-wire 的 deepseek/deepseek-v4-flash（可在 config.json 修改）
 *   • 默认工作目录：~/code/voice-assistant-workspace（agent 的 read/bash 作用域，可在 config.json 修改）
 *
 * 协议：OpenAI /v1/chat/completions (stream=true)
 *   请求里只取 messages 最后一条 user 的 content 作为 prompt；
 *   其余字段（model/temperature 等）忽略，用 pi 配置。
 *
 * 启动：node pi-proxy.mjs
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import { createAgentSession, AuthStorage, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- 0. 配置加载（model / server / cwd / tools） ----------
// 优先级：~/code/pi-proxy/config.json > DEFAULT_CONFIG
// 字段缺失时回退到默认值（向后兼容老 config.json）。
const CONFIG_PATH = join(homedir(), "code", "pi-proxy", "config.json");
const DEFAULT_CONFIG = {
	tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	model: { provider: "llm-wire", id: "deepseek/deepseek-v4-flash" },
	server: { host: "127.0.0.1", port: 8988 },
	cwd: join(homedir(), "code", "voice-assistant-workspace"),
};

/** 把 ~/foo 展开为 homedir()/foo（保留绝对路径原样）。*/
function expandHome(p) {
	if (typeof p !== "string" || !p.startsWith("~")) return p;
	if (p === "~") return homedir();
	return join(homedir(), p.slice(2));
}

function loadProxyConfig() {
	const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // 深拷贝默认值
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		// tools（支持两种 schema：顶层数组，或 {base, extensions}）
		if (Array.isArray(parsed.tools)) cfg.tools = parsed.tools;
		else if (parsed.tools && Array.isArray(parsed.tools.base) && Array.isArray(parsed.tools.extensions)) {
			cfg.tools = [...parsed.tools.base, ...parsed.tools.extensions];
		}
		// model
		if (parsed.model && typeof parsed.model.provider === "string" && typeof parsed.model.id === "string") {
			cfg.model = { provider: parsed.model.provider, id: parsed.model.id };
		}
		// server
		if (parsed.server && typeof parsed.server.host === "string") cfg.server.host = parsed.server.host;
		if (parsed.server && Number.isInteger(parsed.server.port) && parsed.server.port > 0 && parsed.server.port < 65536) {
			cfg.server.port = parsed.server.port;
		}
		// cwd（支持 ~/xxx 简写）
		if (typeof parsed.cwd === "string") cfg.cwd = expandHome(parsed.cwd);
	} catch (e) {
		if (e.code !== "ENOENT") console.error("[pi-proxy] config.json 解析失败，使用默认值:", e.message);
	}
	return cfg;
}

const PROXY_CONFIG = loadProxyConfig();
const PORT = PROXY_CONFIG.server.port;
const HOST = PROXY_CONFIG.server.host;
const CWD = PROXY_CONFIG.cwd;
const TARGET_MODEL = PROXY_CONFIG.model;
const TOOLS = PROXY_CONFIG.tools;
console.error(`[pi-proxy] 配置已加载: model=${TARGET_MODEL.provider}/${TARGET_MODEL.id}, server=${HOST}:${PORT}, cwd=${CWD}`);

// ---------- 1. pi agent 会话管理（默认 continueRecent，可手动新对话） ----------
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const TARGET_MODEL_OBJ = modelRegistry.find(TARGET_MODEL.provider, TARGET_MODEL.id);
if (!TARGET_MODEL_OBJ) {
	console.error(`[pi-proxy] 找不到模型 ${TARGET_MODEL.provider}/${TARGET_MODEL.id}`);
	console.error(`[pi-proxy] 可用模型（已配置 auth）:`);
	for (const m of modelRegistry.getAvailable()) {
		console.error(`[pi-proxy]   - ${m.provider}/${m.id}`);
	}
	console.error(`[pi-proxy] 请检查 ~/code/pi-proxy/config.json 的 model.provider / model.id`);
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
		tools: TOOLS,
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
		model: TARGET_MODEL.id,
		choices: [{
			index: 0,
			delta: delta === null ? { role: "assistant" } : { content: delta },
			finish_reason: null,
		}],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** ★ 思考过程 chunk（delta 用 { reasoning_content: ... }，与 DeepSeek API 一致）。 */
function sseReasoningChunk(reasoning) {
	const payload = {
		id: "chatcmpl-pi",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: TARGET_MODEL.id,
		choices: [{
			index: 0,
			delta: { reasoning_content: reasoning },
			finish_reason: null,
		}],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** ★ 工具调用 chunk（OpenAI 标准 delta.tool_calls）。
 *  index:    工具调用序号（同一 assistant message 内从 0 递增）
 *  id:       工具调用 ID（仅首帧传，后续帧可 null）
 *  name:     工具名（仅首帧传，后续帧可 null）
 *  argsDelta: arguments 增量 JSON 字符串（首帧传 ""，后续帧增量拼接）
 *  协议：第一帧 {index,id,type,function:{name,arguments:""}}，后续帧 {index,function:{arguments:delta}}
 */
function sseToolCallChunk(index, id, name, argsDelta) {
	const tc = { index, type: "function" };
	if (id) tc.id = id;
	if (name) tc.function = { name, arguments: argsDelta };
	else tc.function = { arguments: argsDelta };
	const payload = {
		id: "chatcmpl-pi",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: TARGET_MODEL.id,
		choices: [{
			index: 0,
			delta: { tool_calls: [tc] },
			finish_reason: null,
		}],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** ★ 终止帧：delta 为空，finish_reason 有值。
 *  reason: pi 的 done.reason（"stop"|"length"|"toolUse"）→ OpenAI（"stop"|"length"|"tool_calls"）
 *  usage:  可选，最后一帧带 usage 统计（prompt/completion/total tokens）
 */
function sseFinishChunk(reason, usage) {
	const openaiReason = reason === "toolUse" ? "tool_calls" : reason;
	const choice = {
		index: 0,
		delta: {},
		finish_reason: openaiReason,
	};
	const payload = {
		id: "chatcmpl-pi",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: TARGET_MODEL.id,
		choices: [choice],
	};
	if (usage) payload.usage = usage;
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const SSE_DONE = "data: [DONE]\n\n";

/** ★ 工具执行状态（SSE 注释行，以 ":" 开头，标准 OpenAI 客户端忽略，Argus 可解析）。
 *  作用：让客户端看到 agent 在调用哪个工具、执行成功/失败，不依赖 delta.tool_calls。
 */
function sseCommentToolStart(toolName, toolCallId) {
	return `: [tool_start] ${toolName} id=${toolCallId}\n\n`;
}
function sseCommentToolEnd(toolName, toolCallId, isError) {
	return `: [tool_end] ${toolName} id=${toolCallId} status=${isError ? "error" : "ok"}\n\n`;
}

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

	// 订阅 pi 事件：转 text/thinking/toolcall + message_end 的 finish_reason/usage + 工具执行注释
	let unsubscribe = session.subscribe((event) => {
		try {
			if (event.type === "message_update") {
				const ae = event.assistantMessageEvent;
				// ★ 正文流式（text_delta）
				if (ae && ae.type === "text_delta" && ae.delta) {
					res.write(sseChunk(ae.delta));
				}
				// ★ 思考过程流式（thinking_delta）
				else if (ae && ae.type === "thinking_delta" && ae.delta) {
					res.write(sseReasoningChunk(ae.delta));
				}
				// ★ 工具调用：开始
				else if (ae && ae.type === "toolcall_start") {
					const tc = ae.partial.content[ae.contentIndex];
					if (tc && tc.type === "toolCall") {
						res.write(sseToolCallChunk(ae.contentIndex, tc.id, tc.name, ""));
					}
				}
				// ★ 工具调用：增量
				else if (ae && ae.type === "toolcall_delta" && ae.delta) {
					const tc = ae.partial.content[ae.contentIndex];
					if (tc && tc.type === "toolCall") {
						res.write(sseToolCallChunk(ae.contentIndex, tc.id, null, ae.delta));
					}
				}
				// text_start/end / thinking_start/end / toolcall_end / done 暂不转发
			}
			// ★ 终止帧：message_end 顶层事件
			//  - role=assistant + stopReason ∈ {stop, length, toolUse} → 发 sseFinishChunk
			//  - role=toolResult / role=user → 忽略
			else if (event.type === "message_end") {
				const msg = event.message;
				if (msg && msg.role === "assistant" && msg.stopReason) {
					let usage = null;
					try {
						if (msg.usage) {
							usage = {
								prompt_tokens: msg.usage.input ?? 0,
								completion_tokens: msg.usage.output ?? 0,
								total_tokens: msg.usage.totalTokens ?? ((msg.usage.input ?? 0) + (msg.usage.output ?? 0)),
							};
						}
					} catch {}
					res.write(sseFinishChunk(msg.stopReason, usage));
				}
			}
			// ★ 工具执行状态（SSE 注释行，标准 OpenAI 客户端忽略，Argus 可解析）
			else if (event.type === "tool_execution_start") {
				res.write(sseCommentToolStart(event.toolName, event.toolCallId));
			} else if (event.type === "tool_execution_end") {
				res.write(sseCommentToolEnd(event.toolName, event.toolCallId, !!event.isError));
			}
			// ★ agent 整体结束
			else if (event.type === "agent_end") {
				res.write(SSE_DONE);
				res.end();
				if (unsubscribe) { unsubscribe(); unsubscribe = null; }
			}
			else if (event.type === "extension_error") {
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
			data: [{ id: TARGET_MODEL.id, object: "model", owned_by: "pi-proxy" }],
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

	// ★ 中断当前 agent 运行：调用 session.abort() 停止 pi 端正在执行的 agent run
	//   场景：App 发出新请求但 pi session 还在跑上一个任务（Agent is already processing）
	//   → 客户端可调此接口强制中断老任务，让新请求能继续
	if (req.method === "POST" && (req.url === "/v1/abort" || req.url === "/abort")) {
		try {
			if (session && typeof session.abort === "function") {
				session.abort();
				console.error(`[pi-proxy] 收到 /v1/abort，已调用 session.abort()`);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, aborted: true }));
			} else {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "session 未初始化或不支持 abort" } }));
			}
		} catch (e) {
			console.error("[pi-proxy] /v1/abort 失败:", e.message);
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
