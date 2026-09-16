/**
 * dsh_mobile_app — lib/server.js
 *
 * 手机配对网关核心（与 DSH 进程同机运行）。标准插件 lib/index.js 调用
 * `startMobileServer(config, log)` 启动本服务器；核心不依赖 cordis ctx，
 * 因此可以在独立进程中直接测试。
 *
 * 职责：
 *  1) 令牌认证（持久化到 ~/.dsh/mobile-gateway-token，跨重启稳定；或由 config.token 固定）
 *  2) 会话 Cookie（HttpOnly、SameSite=Lax、可配 TTL；v0.4.1 起过期条目定期清扫）
 *  3) 反向代理到同进程 DSH web server：改写 Host/Origin 使其「信任栅栏」
 *     视为回环客户端（DSH 配置零改动，仍只监听回环）
 *  4) 转发 /api/events.mux|host|remote.mux WebSocket 下行事件流
 *  5) 配对页（仅回环可访问）+ 二维码 + 局域网/远程(Tailscale)候选地址
 *  6) 局域网 UDP 广播（v0.4.0，v0.4.1 拆分至 lib/broadcast.js）：周期声明网关存在
 *
 * v0.4.1 整理：令牌/地址/鉴权/广播拆分为独立模块；修复 SSE 客户端断开后上游
 * 连接泄漏、会话过期条目不回收、转发响应头未剥 hop-by-hop、/pair/connected
 * 未限回环。
 */
import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { defaultTokenFile, readTokenFile, writeTokenFile, tokenFingerprint } from "./token.js";
import { collectAddresses } from "./addresses.js";
import { createDshAliveChecker, createDshAuth } from "./dsh-auth.js";
import { createBroadcaster } from "./broadcast.js";

const PLUGIN_VERSION = "0.4.1";
const COOKIE_NAME = "dsh_gw";
const QR_PREFIX = "dshm://v1/";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAIR_TEMPLATE = fs.readFileSync(path.join(__dirname, "..", "assets", "pair.html"), "utf8");

/** 默认配置；loader 会把行内 config 合并覆盖到其上。 */
const DEFAULTS = Object.freeze({
	enabled: true,
	port: 3081,
	host: "0.0.0.0",
	token: "",
	dshUrl: "http://127.0.0.1:3080",
	wanUrls: [],
	sessionTtlHours: 8,
	openBrowser: true,
	// v0.4.0：局域网 UDP 广播（手机自动发现）与令牌持久化文件
	broadcast: true,
	broadcastPort: 30880,
	broadcastIntervalMs: 3000,
	broadcastTargets: [],
	tokenFile: ""
});

// ---------------------------------------------------------------- 小工具
function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}
function safeEq(a, b) {
	const A = Buffer.from(String(a ?? ""));
	const B = Buffer.from(String(b ?? ""));
	if (A.length !== B.length) return false;
	return crypto.timingSafeEqual(A, B);
}
function parseCookies(req) {
	const h = req.headers.cookie;
	const out = {};
	if (!h) return out;
	for (const part of h.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}
function isLoopback(req) {
	const addr = req.socket.remoteAddress ?? "";
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function stripHopHeaders(headers, isSse = false) {
	const h = { ...headers };
	delete h.host;
	delete h.connection;
	delete h["proxy-connection"];
	delete h["keep-alive"];
	delete h.upgrade;
	delete h["transfer-encoding"];
	delete h["proxy-authorization"];
	delete h["proxy-authenticate"];
	delete h.te;
	delete h.trailer;
	if (isSse) {
		// SSE 长连接：保留必要的缓存头（已由 forward 重写），连接由 Node 管理
		h["cache-control"] = "no-store";
	}
	return h;
}
/** v0.4.1：剥响应侧 hop-by-hop 头——Node 自管 chunked/keep-alive，显式透传会打架。 */
function stripHopResponseHeaders(h) {
	delete h.connection;
	delete h["keep-alive"];
	delete h["transfer-encoding"];
	delete h["proxy-connection"];
	delete h.upgrade;
	return h;
}

/**
 * 启动手机配对服务器。
 * @param {object} merged - 已合并 DEFAULTS 与用户 config 的配置。
 * @param {object} [log] - { info, warn, error }；缺省回落 console。
 * @returns {Promise<{server, token, addresses, dshUrl, close}>}
 */
async function startMobileServer(merged, log = console) {
	const config = { ...DEFAULTS, ...merged };
	if (config.enabled === false) {
		log.info?.("dsh_mobile_app: disabled, skipping");
		return null;
	}
	// v0.4.0：令牌初始化链——config.token 显式配置 > 持久化文件（跨重启稳定，手机首次
	// 扫码存储的令牌因此终身有效）> 随机生成并写入文件。文件损坏/不可写只降级不致命。
	const tokenFile = config.tokenFile || defaultTokenFile();
	const persisted = readTokenFile(tokenFile, log);
	let token = config.token || persisted || crypto.randomBytes(32).toString("base64url");
	if (!config.token && !persisted) writeTokenFile(tokenFile, token, log);
	const hostName = os.hostname() || "DSH-Desktop";
	const sessionTtlMs = Math.max(1, Number(config.sessionTtlHours) || 8) * 3600 * 1000;
	const dshAuthority = new URL(config.dshUrl).host;
	const dshOrigin = config.dshUrl;
	const sessions = new Map();
	let dshAlive = false;
	// DSH web 鉴权（v0.3.2）：见 lib/dsh-auth.js 注释
	const dshAuth = createDshAuth(config.dshUrl, log);
	// v0.4.1：上游存活检查（3s 正向缓存，重连风暴时不再放大上游请求）
	const checkDshAlive = createDshAliveChecker(config.dshUrl);

	// ------------------------------------------------ 会话管理（v0.4.1 清扫）
	const createSession = () => {
		const id = crypto.randomBytes(32).toString("base64url");
		sessions.set(id, Date.now() + sessionTtlMs);
		return id;
	};
	const hasValidSession = (req) => {
		const id = parseCookies(req)[COOKIE_NAME];
		if (!id || !sessions.has(id)) return false;
		const exp = sessions.get(id);
		if (exp < Date.now()) { sessions.delete(id); return false; }
		return true;
	};
	/** v0.4.1：清扫过期会话条目——此前只在同 id 再次被访问时删除，无人再访问的
	 *  过期会话（App 每次重连/加载都会 createSession）永久滞留 Map，内存缓慢增长。 */
	const sweepSessions = () => {
		const now = Date.now();
		for (const [id, exp] of sessions) if (exp < now) sessions.delete(id);
	};
	const sweepTimer = setInterval(sweepSessions, 3600 * 1000);
	sweepTimer.unref?.(); // 不阻止进程退出
	const cookieHeader = (id) => `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}`;

	const buildProfileJson = () => {
		const addrs = collectAddresses();
		return {
			v: 1,
			name: hostName,
			port: config.port,
			lan: addrs.lan.map((ip) => `${ip}:${config.port}`),
			wan: [...addrs.wan.map((ip) => `${ip}:${config.port}`), ...config.wanUrls],
			token
		};
	};
	const qrText = (profile) => QR_PREFIX + Buffer.from(JSON.stringify(profile), "utf8").toString("base64url");

	/** 当前配对信息：令牌、二维码(dataURL)、配对 URL、局域网/远程候选地址。 */
	const getPairingInfo = async () => {
		const profile = buildProfileJson();
		const url = qrText(profile);
		let qr = "";
		try { qr = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 480 }); } catch (e) { log.error?.("qrcode render failed: " + e); }
		return {
			token,
			name: hostName,
			port: config.port,
			pairingUrl: url,
			qr,
			links: { lan: profile.lan, wan: profile.wan }
		};
	};
	/** 轮换配对令牌（config.token 仅是启动初值；主动重新生成会换成新的随机令牌），返回新配对信息。 */
	const rotateToken = async () => {
		token = crypto.randomBytes(32).toString("base64url");
		// v0.4.0：轮换后写回持久化文件，重启后仍用新令牌（旧令牌随之失效）
		if (!config.token) writeTokenFile(tokenFile, token, log);
		return getPairingInfo();
	};
	/** 撤销全部已建立会话（手机需重新扫码配对）。 */
	const revokeSessions = () => {
		const count = sessions.size;
		sessions.clear();
		return { ok: true, revoked: count };
	};

	async function servePairPage(req, res) {
		const profile = buildProfileJson();
		let qr = "";
		try { qr = await QRCode.toDataURL(qrText(profile), { errorCorrectionLevel: "M", margin: 2, width: 480 }); } catch (e) { log.error?.("qrcode render failed: " + e); }
		dshAlive = await checkDshAlive();
		const addrs = collectAddresses();
		const renderList = (items) => items.length
			? items.map((it) => `<code>${escapeHtml(it)}</code>`).join("<br/>")
			: '<span class="muted">（未检测到）</span>';
		const html = PAIR_TEMPLATE
			.replaceAll("__TITLE__", "DSH 手机连接 · 配对")
			.replaceAll("__QR__", qr)
			.replaceAll("__NAME__", escapeHtml(hostName))
			.replaceAll("__PORT__", String(config.port))
			.replaceAll("__LAN__", renderList(addrs.lan.map((ip) => `${ip}:${config.port}`)))
			.replaceAll("__WAN__", renderList([...addrs.wan.map((ip) => `${ip}:${config.port}`), ...config.wanUrls]))
			.replaceAll("__DSH_STATUS__", dshAlive ? "运行中" : "未运行")
			.replaceAll("__DSH_CLASS__", dshAlive ? "ok" : "bad")
			.replaceAll("__DSH_URL__", escapeHtml(config.dshUrl))
			.replaceAll("__TOKEN__", escapeHtml(token))
			.replaceAll("__PAIR_URL__", escapeHtml(`http://127.0.0.1:${config.port}/pair`));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	}

	function forward(req, res) {
		let upstream;
		try { upstream = new URL(req.url, config.dshUrl); } catch { sendJson(res, 400, { error: "bad url" }); return; }
		// SSE 长连接（事件流）需禁用连接池并保持连接活跃，否则提问/审批等实时事件可能不达
		// v0.3.2：新增 /plugins/events（新版 DSH 的 SSE 事件流）——否则按普通请求 30s 超时杀流
		const isSse = upstream.pathname === "/api/events.mux" || upstream.pathname === "/api/events.host" || upstream.pathname === "/plugins/events";
		const headers = stripHopHeaders(req.headers, isSse);
		headers.host = dshAuthority;
		if (headers.origin) headers.origin = dshOrigin;
		dshAuth.inject(headers); // v0.3.2：注入缓存的 DSH 会话 cookie，上游鉴权必需
		if (isSse) {
			headers.accept = "text/event-stream";
			headers["cache-control"] = "no-store";
		}
		const ureq = http.request(upstream, {
			method: req.method,
			headers,
			...(isSse ? { agent: false } : {})
		}, (ures) => {
			if (ures.statusCode === 401) dshAuth.note401(); // cookie 失效时节流重换
			const h = stripHopResponseHeaders({ ...ures.headers }); // v0.4.1：剥响应侧 hop-by-hop 头
			if (req.method === "GET" && req.url.startsWith("/assets/")) {
				h["cache-control"] = "public, max-age=31536000, immutable";
			} else if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/manifest") || req.url.startsWith("/favicon") || req.url.startsWith("/fonts/"))) {
				h["cache-control"] = "no-cache";
			} else if (isSse) {
				h["cache-control"] = "no-store";
				h["connection"] = "keep-alive";
			}
			res.writeHead(ures.statusCode, h);
			ures.pipe(res);
		});
		ureq.setTimeout(isSse ? 0 : 30000, () => {
			if (isSse) return; // SSE 长连接不设超时
			ureq.destroy(new Error("proxy request timeout"));
		});
		ureq.on("error", (err) => {
			log.warn?.(`[proxy] ${req.method} ${req.url} -> ${err.message}`);
			if (!res.headersSent) {
				res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify({ error: "dsh upstream unavailable", detail: err.message }));
			} else {
				res.end();
			}
		});
		// v0.4.1：客户端断开 → 立即销毁上游请求。SSE 永不超时（setTimeout 0），此前
		// 客户端切页/重连留下的上游 SSE 连接无人回收，长期运行持续累积（连接泄漏）。
		// 普通请求同样受益：客户端早断后 pipe 无人消费。响应已完成的销毁是 no-op。
		res.on("close", () => { try { ureq.destroy(); } catch { /* ignore */ } });
		req.pipe(ureq);
	}

	function rejectUpgrade(socket) {
		socket.end([
			"HTTP/1.1 403 Forbidden",
			"Connection: close",
			"Content-Type: text/plain; charset=utf-8",
			"Content-Length: 9",
			"",
			"forbidden"
		].join("\r\n"));
	}

	const wss = new WebSocketServer({ noServer: true });
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://x");
		const pathname = url.pathname;

		if (pathname === "/pair" || pathname === "/pair/") {
			if (!isLoopback(req)) return sendJson(res, 403, { error: "pairing page is loopback only" });
			return servePairPage(req, res).catch((e) => {
				log.error?.("[pair] render failed: " + e);
				sendJson(res, 500, { error: "pair page error" });
			});
		}

		if (pathname === "/pair/probe") {
			if (!safeEq(url.searchParams.get("t"), token)) return sendJson(res, 401, { error: "unauthorized" });
			dshAlive = await checkDshAlive();
			return sendJson(res, 200, { ok: true, name: hostName, version: PLUGIN_VERSION, dsh: dshAlive, port: config.port });
		}

		// 配对页轮询：返回当前活跃会话数（用于检测手机连接后自动跳转）。
		// v0.4.1：限回环（LAN 内他人不应能探测会话数）+ 先清扫过期条目再计数。
		if (pathname === "/pair/connected") {
			if (!isLoopback(req)) return sendJson(res, 403, { error: "pairing status is loopback only" });
			sweepSessions();
			return sendJson(res, 200, { sessions: sessions.size });
		}

		const t = url.searchParams.get("token");
		if (t !== null && safeEq(t, token)) {
			const sid = createSession();
			const params = new URLSearchParams(url.search);
			params.delete("token");
			const qs = params.toString();
			res.writeHead(302, { Location: pathname + (qs ? `?${qs}` : ""), "Set-Cookie": cookieHeader(sid) });
			res.end();
			return;
		}

		if (!hasValidSession(req)) return sendJson(res, 401, { error: "unauthorized" });
		forward(req, res);
	});

	server.on("upgrade", (req, socket, head) => {
		let url;
		try { url = new URL(req.url, config.dshUrl); } catch { return rejectUpgrade(socket); }
		// v0.3.2：新增 /api/remote.mux（新版 DSH 的 WS 复用通道，GUI 连接异常的直接原因）
		if (url.pathname !== "/api/events.mux" && url.pathname !== "/api/events.host" && url.pathname !== "/api/remote.mux") return rejectUpgrade(socket);
		if (!hasValidSession(req)) return rejectUpgrade(socket);

		const headers = stripHopHeaders(req.headers);
		headers.host = dshAuthority;
		headers.origin = dshOrigin;
		dshAuth.inject(headers); // v0.3.2：WS 升级请求同样注入 DSH 会话 cookie
		const upstream = new WebSocket(url.toString(), { headers, handshakeTimeout: 5000 });
		let down = null;
		wss.handleUpgrade(req, socket, head, (ws) => {
			down = ws;
			// 转发必须保留帧类型：ws 库对文本帧也可能以 Buffer 交给 message 回调，
			// 直接 send(Buffer) 会被强制发成「二进制帧」，手机端 dsh-client-connection
			// 只认文本帧 → 全部丢弃 → 无法发送消息（控制台狂刷 binary WebSocket frame）。
			ws.on("message", (data, isBinary) => { try { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: !!isBinary }); } catch {} });
			ws.on("close", () => { try { upstream.close(); } catch {} });
			ws.on("error", () => { try { upstream.close(); } catch {} });
		});
		upstream.on("message", (data, isBinary) => { try { if (down && down.readyState === WebSocket.OPEN) down.send(data, { binary: !!isBinary }); } catch {} });
		upstream.on("close", () => { try { if (down && down.readyState === WebSocket.OPEN) down.close(); } catch {} });
		upstream.on("error", () => { try { if (down && down.readyState === WebSocket.OPEN) down.close(); } catch {} });
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// ---------------------------------------------------------------- 局域网 UDP 广播（v0.4.0，v0.4.1 拆分）
	// 载荷工厂每次调用实时计算（轮换令牌后指纹自动跟随）；广播目标每次发送重算
	//（见 lib/broadcast.js——网络/IP 变化后定向广播自动跟随，自愈发现不失效）。
	const broadcaster = createBroadcaster({
		payload: () => JSON.stringify({ v: 1, app: "dshm-gw", name: hostName, port: config.port, fp: tokenFingerprint(token) }),
		port: config.broadcastPort,
		intervalMs: config.broadcastIntervalMs,
		extraTargets: config.broadcastTargets,
		enabled: config.broadcast !== false,
		log
	});
	broadcaster.start();

	const addresses = collectAddresses();
	// 启动时刷新一次上游健康状态，供配对页/探测即时反馈
	dshAlive = await checkDshAlive().catch(() => false);
	return {
		server,
		get token() { return token; },
		addresses,
		port: config.port,
		dshUrl: config.dshUrl,
		getPairingInfo,
		rotateToken,
		revokeSessions,
		/** v0.3.2：由 index.js 传入 connection.authenticatedUrl(dshUrl) 的结果，触发 cookie 交换。 */
		setDshAuthUrl: (url) => dshAuth.setAuthUrl(url),
		close: () => new Promise((resolve) => {
			broadcaster.stop();
			clearInterval(sweepTimer); // v0.4.1：停止会话清扫定时器
			for (const s of wss.clients) s.terminate();
			wss.close(() => server.close(() => resolve()));
		})
	};
}

export { DEFAULTS, PLUGIN_VERSION, collectAddresses, startMobileServer };
