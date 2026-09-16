/**
 * dsh_mobile_app — 标准 DeepSeek Harness 插件入口。
 *
 * 规格要点（与 dsh-desktop-shortcut 同模式）：
 *  - 命名导出 `name` / `apply`，另保留默认导出兼容；
 *  - 插件模块只依赖 Node 内置模块 + 自身 node_modules（ws、qrcode），
 *    dsh loader 按 file:// 导入即可，无需 pnpm 安装；
 *  - apply() 永不抛出：任何失败只记录，绝不影响 dsh 引导；
 *  - apply() 返回 disposer（v0.4.1）：插件卸载/重载时关闭网关与已注册路由，
 *    此前旧实例不关闭会导致重载后端口占用（EADDRINUSE）；
 *  - 通过 `ctx.get("loader")?.await()` 等引导完成后读取 webServer 真实端口，
 *    再启动手机配对服务器。
 */
import { spawn } from "node:child_process";
import { DEFAULTS, startMobileServer } from "./server.js";
import { injectMobilePatch } from "./mobile-patch.js";
import { injectSettingsPairing } from "./settings-pairing.js";

/** 稳定 Cordis 插件名。 */
const name = "dsh_mobile_app";

/** 运行中的网关实例（startMobileServer 返回），供设置面板路由读取/操作。 */
let mobileServer = null;

/** connection 服务就绪后取得的 DSH 鉴权 URL（若早于网关启动则暂存）。 */
let pendingDshAuthUrl = null;

/** 交接 DSH 鉴权 URL 给网关（已启动则立即，未启动则暂存待 settle 后交接）。 */
function handOffDshAuthUrl(url) {
	pendingDshAuthUrl = url;
	try { mobileServer?.setDshAuthUrl?.(url); } catch { /* 网关未就绪，settle 时交接 */ }
}

/**
 * 统一推导上游 DSH web 基址（v0.4.1：settle 与 connection 注入回调共用，
 * 此前两处逐句重复，易在调整时失配）。规则：显式配置了非默认 dshUrl > webServer
 * 实际绑定端口（全接口/回环字面量折算回环）> 配置值原样。
 */
function resolveDshUrl(merged, web) {
	if (merged.dshUrl && merged.dshUrl !== DEFAULTS.dshUrl) return merged.dshUrl;
	if (web) return `http://${loopbackHostOf(web.host)}:${web.port}`;
	return merged.dshUrl;
}

/**
 * 在 DSH web server 上注册「配对/管理连接」REST 路由（同源 fetch，无需 CORS）。
 * 路由 handler 是标准 Node (req, res)；网关未就绪时返回 503。
 * @param {object} web - webServer 服务（须有 register）。
 * @param {() => object|null} getServer - 返回运行中网关实例（可延迟就绪）。
 * @returns {Function} disposer。
 */
function registerPairingRoutes(web, getServer) {
	const disposers = [];
	if (!web || typeof web.register !== "function") return () => {};
	const add = (path, handler) => {
		try { disposers.push(web.register({ kind: "exact", path, handler })); } catch (e) { /* 路径冲突忽略 */ }
	};
	const json = (res, status, obj) => {
		const body = JSON.stringify(obj);
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(body);
	};
	const withServer = async (req, res, fn) => {
		const s = typeof getServer === "function" ? getServer() : getServer;
		if (!s) return json(res, 503, { error: "mobile gateway not ready" });
		try {
			return json(res, 200, await fn(s));
		} catch (e) {
			return json(res, 500, { error: String(e?.message || e) });
		}
	};
	add("/api/dsh-mobile/pair", (req, res) => {
		if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
		return withServer(req, res, (s) => s.getPairingInfo());
	});
	add("/api/dsh-mobile/pair/regenerate", (req, res) => {
		if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
		return withServer(req, res, (s) => s.rotateToken());
	});
	add("/api/dsh-mobile/pair/revoke", (req, res) => {
		if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
		return withServer(req, res, (s) => Promise.resolve(s.revokeSessions()));
	});
	return () => disposers.forEach((d) => { try { d?.(); } catch {} });
}

/** 处理 webServer 的绑定 host：全接口/回环字面量一律用回环转发。 */
function loopbackHostOf(bindHost) {
	if (!bindHost) return "127.0.0.1";
	if (bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "::0" || bindHost === "::ffff:0.0.0.0") return "127.0.0.1";
	return bindHost;
}

/** 用系统默认浏览器打开 URL（各平台尽力而为）。 */
function openBrowser(url, log) {
	try {
		const cmd = process.platform === "win32"
			? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
			: process.platform === "darwin"
				? spawn("open", [url], { detached: true, stdio: "ignore" })
				: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		cmd?.unref?.();
	} catch (e) {
		log.warn?.(`openBrowser failed: ${e}`);
	}
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 插件上下文。
 * @param {object} config - loader 行内配置（覆盖 DEFAULTS）。
 * @returns {Function} disposer——关闭网关实例并注销已注册路由（v0.4.1）。
 */
function apply(ctx, config) {
	const logger = ctx?.logger?.(name) || {
		info: (m) => console.log(`[${name}] ${m}`),
		warn: (m) => console.warn(`[${name}] ${m}`),
		error: (m) => console.error(`[${name}] ${m}`)
	};
	// v0.4.1：统一收集 disposer（/mobile/pair 入口 + 配对 REST 路由 + 网关实例），
	// 插件卸载/重载时全部释放；settle 在 disposer 之后才执行则不再启动（防泄漏）。
	const disposers = [];
	let disposed = false;
	try {
		const merged = { ...DEFAULTS, ...(config ?? {}) };
		if (merged.enabled === false) {
			logger.info?.("disabled, skipping");
			return () => {};
		}

		const settle = async () => {
			if (disposed) return; // 插件已卸载，不再启动
			try {
				const web = ctx?.get?.("webServer");
				const dshUrl = resolveDshUrl(merged, web);
				if (!web) logger.warn?.("webServer 服务不可用（非 web profile？），使用默认上游 " + dshUrl);

				// 可选增强：在主 GUI 来源挂一个 /mobile/pair 入口（302 到配对页）
				if (web && typeof web.register === "function") {
					try {
						const d = web.register({
							kind: "exact",
							path: "/mobile/pair",
							handler: (req, res) => {
								res.writeHead(302, { Location: `http://127.0.0.1:${merged.port}/pair` });
								res.end();
							}
						});
						disposers.push(d); // v0.4.1：此前未收集，插件重载时该路由残留
						logger.info?.("GUI 入口已挂载: http://127.0.0.1:" + web.port + "/mobile/pair");
					} catch (e) {
						logger.warn?.("挂载 /mobile/pair 入口失败（可能已被占用）: " + e);
					}
				}

				// 手机端适配补丁 + 设置「手机配对」入口：
				// crypto.randomUUID 补齐 / 侧边栏图标 / 设置导航折叠 / 配对管理面板
				// （tapIndex 是 webServer 的标准扩展点，对所有 index 响应生效；
				//   补丁脚本自带移动端判定，设置入口对所有客户端可用）
				if (web && typeof web.tapIndex === "function") {
					try {
						web.tapIndex((html) => injectSettingsPairing(injectMobilePatch(html)));
						logger.info?.("前端补丁已挂载（randomUUID/侧边栏图标/设置导航/设置配对入口）");
					} catch (e) {
						logger.warn?.("挂载前端补丁失败: " + e);
					}
				}

				// 设置面板用的「配对/管理连接」REST 路由（网关未就绪时 503）
				disposers.push(registerPairingRoutes(web, () => mobileServer));

				const instance = await startMobileServer({ ...merged, dshUrl }, logger);
				if (!instance) return;
				mobileServer = instance;
				// v0.3.2：DSH web 鉴权——connection 服务提供的带 launch-token URL，
				// 网关据此自行完成 token→cookie 交换并在转发时注入（若 inject 早于本步
				// 已暂存 pendingDshAuthUrl，此处立即交接）。
				if (pendingDshAuthUrl) instance.setDshAuthUrl?.(pendingDshAuthUrl);
				logger.info?.("手机配对网关已启动");
				logger.info?.("  配对页(本机浏览器): http://127.0.0.1:" + instance.port + "/pair");
				for (const ip of instance.addresses.lan) logger.info?.("  局域网地址: http://" + ip + ":" + instance.port);
				for (const ip of instance.addresses.wan) logger.info?.("  远程(Tailscale): http://" + ip + ":" + instance.port);
				for (const u of merged.wanUrls) logger.info?.("  远程(自定义): " + u);
				logger.info?.("  上游 DSH web: " + instance.dshUrl);
				if (merged.openBrowser) openBrowser(`http://127.0.0.1:${instance.port}/pair`, logger);
			} catch (e) {
				logger.error?.("mobile gateway 启动失败: " + (e?.stack || e));
			}
		};

		const loader = ctx?.get?.("loader");
		if (loader?.await) loader.await().then(settle, (e) => logger.error?.("loader await failed: " + e));
		else settle();

		// v0.3.2：connection 服务就绪后取 DSH 鉴权 URL（launch token 仅进程内可得）。
		// 注入回调先于/晚于 settle 都兼容：handOffDshAuthUrl 内部处理两种时序。
		try {
			ctx.inject?.(["connection"], (cctx) => {
				try {
					if (disposed) return; // 插件已卸载
					const conn = cctx?.connection;
					if (!conn || typeof conn.authenticatedUrl !== "function") return;
					const web = ctx?.get?.("webServer");
					// cookie 绑定 authority（Host 头），必须与网关转发时设置的
					// host=dshAuthority 完全相同——推导逻辑统一走 resolveDshUrl
					const authBase = resolveDshUrl(merged, web);
					handOffDshAuthUrl(conn.authenticatedUrl(authBase));
					logger.info?.("已取得 DSH 鉴权 URL，交接给手机网关");
				} catch (e) {
					logger.warn?.("获取 DSH 鉴权 URL 失败: " + (e?.message || e));
				}
			});
		} catch (e) {
			logger.warn?.("挂载 connection 注入失败: " + (e?.message || e));
		}
	} catch (e) {
		console.error(`[${name}] apply 异常: ${e?.stack || e}`);
	}
	// v0.4.1：disposer——关闭网关（连带 UDP 广播/会话清扫定时器/全部 WS）+ 注销路由
	return () => {
		disposed = true;
		try { mobileServer?.close?.(); } catch { /* ignore */ }
		mobileServer = null;
		for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
		disposers.length = 0;
	};
}

export { DEFAULTS, apply, name, registerPairingRoutes, startMobileServer };
export default { name, apply };
