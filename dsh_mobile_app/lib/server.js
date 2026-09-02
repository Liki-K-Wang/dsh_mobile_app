/**
 * dsh_mobile_app — lib/server.js
 *
 * 手机配对网关核心（与 DSH 进程同机运行）。标准插件 lib/index.js 调用
 * `startMobileServer(config, log)` 启动本服务器；核心不依赖 cordis ctx，
 * 因此可以在独立进程中直接测试。
 *
 * 职责：
 *  1) 令牌认证（每次 dsh 启动随机 256-bit；或由 config.token 固定）
 *  2) 会话 Cookie（HttpOnly、SameSite=Lax、可配 TTL）
 *  3) 反向代理到同进程 DSH web server：改写 Host/Origin 使其「信任栅栏」
 *     视为回环客户端（DSH 配置零改动，仍只监听回环）
 *  4) 转发 /api/events.mux|host WebSocket 下行事件流
 *  5) 配对页（仅回环可访问）+ 二维码 + 局域网/远程(Tailscale)候选地址
 */
import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import QRCode from "qrcode";

const PLUGIN_VERSION = "0.3.0";
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
	openBrowser: true
});

// ---------------------------------------------------------------- 网络地址收集
function isPrivateV4(a) {
	const p = a.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
	return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 127;
}
function isCgnatV4(a) {
	const p = a.split(".").map(Number);
	return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
function collectAddresses() {
	const lan = [];
	const wan = [];
	const other = [];
	for (const ifaces of Object.values(os.networkInterfaces())) {
		for (const i of ifaces ?? []) {
			if (i.family !== "IPv4" || i.internal) continue;
			const a = i.address;
			if (isPrivateV4(a)) lan.push(a);
			else if (isCgnatV4(a)) wan.push(a);
			else other.push(a);
		}
	}
	return { lan: [...new Set(lan)], wan: [...new Set(wan)], other: [...new Set(other)] };
}

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

// ---------------------------------------------------------------- DSH 健康检查
function checkDshAlive(dshUrl) {
	return new Promise((resolve) => {
		let req;
		try { req = http.get(dshUrl + "/", { timeout: 1500 }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode === 200));
			res.on("error", () => resolve(false));
		}); } catch { resolve(false); return; }
		req.on("error", () => resolve(false));
		req.on("timeout", () => { req.destroy(); resolve(false); });
	});
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
	let token = config.token || crypto.randomBytes(32).toString("base64url");
	const hostName = os.hostname() || "DSH-Desktop";
	const sessionTtlMs = Math.max(1, Number(config.sessionTtlHours) || 8) * 3600 * 1000;
	const dshAuthority = new URL(config.dshUrl).host;
	const dshOrigin = config.dshUrl;
	const sessions = new Map();
	let dshAlive = false;

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
		dshAlive = await checkDshAlive(config.dshUrl);
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
		const isSse = upstream.pathname === "/api/events.mux" || upstream.pathname === "/api/events.host";
		const headers = stripHopHeaders(req.headers, isSse);
		headers.host = dshAuthority;
		if (headers.origin) headers.origin = dshOrigin;
		if (isSse) {
			headers.accept = "text/event-stream";
			headers["cache-control"] = "no-store";
		}
		const ureq = http.request(upstream, {
			method: req.method,
			headers,
			...(isSse ? { agent: false } : {})
		}, (ures) => {
			const h = { ...ures.headers };
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
			dshAlive = await checkDshAlive(config.dshUrl);
			return sendJson(res, 200, { ok: true, name: hostName, version: PLUGIN_VERSION, dsh: dshAlive, port: config.port });
		}

		// 配对页轮询：返回当前活跃会话数（用于检测手机连接后自动跳转）
		if (pathname === "/pair/connected") {
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
		if (url.pathname !== "/api/events.mux" && url.pathname !== "/api/events.host") return rejectUpgrade(socket);
		if (!hasValidSession(req)) return rejectUpgrade(socket);

		const headers = stripHopHeaders(req.headers);
		headers.host = dshAuthority;
		headers.origin = dshOrigin;
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

	const addresses = collectAddresses();
	// 启动时刷新一次上游健康状态，供配对页/探测即时反馈
	dshAlive = await checkDshAlive(config.dshUrl).catch(() => false);
	return {
		server,
		get token() { return token; },
		addresses,
		port: config.port,
		dshUrl: config.dshUrl,
		getPairingInfo,
		rotateToken,
		revokeSessions,
		close: () => new Promise((resolve) => {
			for (const s of wss.clients) s.terminate();
			wss.close(() => server.close(() => resolve()));
		})
	};
}

export { DEFAULTS, PLUGIN_VERSION, collectAddresses, startMobileServer };
