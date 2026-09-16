/**
 * dsh_mobile_app — lib/dsh-auth.js
 *
 * DSH web 鉴权集成（v0.3.2 引入）+ 上游健康检查。
 *
 * DSH 更新后 web GUI 启用鉴权：无凭据请求一律 401，需经启动打印的带 token URL
 * 完成「GET /?token=<launchToken> → 303 + Set-Cookie」换取 authority 绑定的签名
 * 会话 cookie（dsh-auth-<hash(authority)>，密钥持久化）。网关与 DSH 同进程，由
 * lib/index.js 通过 ctx.inject(["connection"]) → connection.authenticatedUrl(dshUrl)
 * 取得鉴权 URL 交给本模块；本模块自行完成交换并缓存 cookie，注入到所有转发请求
 * （HTTP forward + WS upgrade）。cookie 绑定 authority（Host 头）——转发统一设置
 * host=dshAuthority，与交换时的 Host 一致，因此缓存 cookie 对全部转发请求有效。
 */
import http from "node:http";

/**
 * 上游存活检查（带 3s 正向缓存）。
 * v0.4.1：手机重连风暴时每个 probe 都会打一次上游；健康结果（alive=true）缓存 3s，
 * 失败结果不缓存（mock 下线→上线的关键测试路径保持即时生效）。
 * 判定语义（v0.3.1）：任何 HTTP 响应（200/302/401/404）都证明 DSH 进程在跑；
 * 仅连接失败/超时/5xx 判死。
 */
export function createDshAliveChecker(dshUrl) {
	let okCache = false;
	let okAt = 0;
	const OK_TTL = 3000;
	return function checkDshAlive() {
		if (okCache && Date.now() - okAt < OK_TTL) return Promise.resolve(true);
		return checkDshAliveOnce(dshUrl).then((alive) => {
			if (alive) { okCache = true; okAt = Date.now(); }
			else { okCache = false; okAt = 0; }
			return alive;
		});
	};
}

/** 单次存活检查：GET /，任何 <500 响应视为存活。 */
function checkDshAliveOnce(dshUrl) {
	return new Promise((resolve) => {
		let req;
		try { req = http.get(dshUrl + "/", { timeout: 1500 }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode < 500));
			res.on("error", () => resolve(false));
		}); } catch { resolve(false); return; }
		req.on("error", () => resolve(false));
		req.on("timeout", () => { req.destroy(); resolve(false); });
	});
}

/** 从 Set-Cookie 头数组提取 "k=v" 对（丢弃属性），拼成上游 Cookie 头。 */
function parseSetCookie(arr) {
	const pairs = [];
	for (const raw of arr ?? []) {
		const first = String(raw).split(";")[0];
		if (first && first.includes("=")) pairs.push(first.trim());
	}
	return pairs.join("; ");
}

/** 单次交换：GET authUrl（带 launch token）→ 303 + Set-Cookie → cookie 头。 */
function exchange(targetUrl, log) {
	return new Promise((resolve) => {
		let req;
		try { req = http.get(targetUrl, { timeout: 4000 }, (res) => {
			res.resume();
			res.on("end", () => {
				const cookie = parseSetCookie(res.headers["set-cookie"]);
				if ((res.statusCode === 303 || res.statusCode === 200) && cookie) resolve(cookie);
				else { log.warn?.(`[dsh-auth] 交换得到 HTTP ${res.statusCode}，无可用 cookie`); resolve(null); }
			});
			res.on("error", () => resolve(null));
		}); } catch { resolve(null); return; }
		req.on("error", () => resolve(null));
		req.on("timeout", () => { req.destroy(); resolve(null); });
	});
}

/**
 * 创建 DSH 会话 cookie 交换器：setAuthUrl 触发带重试的交换循环，inject 注入缓存
 * cookie，note401 在 cookie 失效（密钥轮换/凭据删除）时节流重换（60s 内至多一次）。
 */
export function createDshAuth(dshUrl, log) {
	const state = { authUrl: null, cookie: null, scheduling: false };
	let lastReauthAt = 0;
	/** 带重试的交换循环（webServer/connection 可能尚未就绪）。 */
	const schedule = (targetUrl, delayMs = 1500, attempts = 20) => {
		if (state.scheduling) return;
		state.scheduling = true;
		let left = attempts;
		const tick = async () => {
			const cookie = await exchange(targetUrl, log);
			if (cookie) {
				state.cookie = cookie;
				state.scheduling = false;
				log.info?.("[dsh-auth] DSH 会话 cookie 已获取，转发请求将自动注入");
				return;
			}
			left -= 1;
			if (left > 0) setTimeout(tick, delayMs);
			else { state.scheduling = false; log.warn?.("[dsh-auth] DSH 会话 cookie 交换失败（重试已用尽），转发将无鉴权注入"); }
		};
		setTimeout(tick, 0);
	};
	return {
		/** 由 index.js 注入 connection.authenticatedUrl(dshUrl) 的结果。 */
		setAuthUrl(url) {
			if (!url || typeof url !== "string") return;
			const changed = url !== state.authUrl;
			state.authUrl = url;
			if (changed || !state.cookie) schedule(url);
		},
		/** 转发请求注入缓存的 DSH 会话 cookie（替换客户端侧网关 cookie，上游不认它）。 */
		inject(headers) {
			if (state.cookie) headers.cookie = state.cookie;
		},
		/** 上游返回 401：cookie 失效，节流重换。仅在「曾拿到过 cookie」后才视为失效；
		 *  启动预热期的 401 由 schedule 自身重试覆盖。 */
		note401() {
			if (!state.cookie) return;
			const now = Date.now();
			if (!state.authUrl || now - lastReauthAt < 60_000) return;
			lastReauthAt = now;
			log.warn?.("[dsh-auth] 上游 401，重新交换会话 cookie");
			schedule(state.authUrl, 1000, 3);
		}
	};
}
