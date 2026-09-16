/**
 * dsh_mobile_app — lib/broadcast.js
 *
 * 局域网 UDP 广播器（v0.4.0 引入，v0.4.1 拆分并修复目标过期）。
 * 周期声明网关存在：{v, app, name, port, fp}。fp = sha256(token) 前 8 位 hex——
 * 手机端用首次扫码存储的令牌同算指纹预匹配，命中后再以令牌走 /pair/probe 正式校验。
 * 载荷不含令牌本体；广播仅暴露「此处有网关」，与 mDNS 同级泄露，无令牌无法连接。
 *
 * v0.4.1 修复：广播目标不再在启动时闭包固定——每次发送重算（255.255.255.255 +
 * 各私网网段定向广播 + 附加单播目标）。DHCP 换 IP/换网段后定向广播自动跟随，
 * 手机端自动发现（断线自愈的关键前提）不因网络变化失效。
 */
import dgram from "node:dgram";
import { collectAddresses } from "./addresses.js";

/**
 * @param {object} opts
 * @param {(s: string) => string} opts.payload - 每次发送时调用的载荷工厂（令牌指纹保持新鲜）。
 * @param {number} opts.port - 广播目标端口。
 * @param {number} opts.intervalMs - 发送间隔（下限 1000ms）。
 * @param {string[]} [opts.extraTargets] - 附加单播目标（AP 隔离兜底 / 测试回环注入）。
 * @param {boolean} opts.enabled - false 时 start() 为 no-op。
 * @param {object} opts.log - { info, warn }。
 */
export function createBroadcaster({ payload, port, intervalMs, extraTargets, enabled, log }) {
	let timer = null;
	let socket = null;

	/** 每次发送重算目标集合（成本可忽略：3s 一次网卡枚举）。 */
	const computeTargets = () => {
		const targets = new Set(["255.255.255.255"]);
		// 每个私网网段的定向广播地址（多网卡全覆盖；255.255.255.255 部分路由器不转发）
		for (const ip of collectAddresses().lan) {
			const octets = ip.split(".").map(Number);
			if (octets.length === 4) targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`);
		}
		for (const t of extraTargets ?? []) {
			if (typeof t === "string" && t) targets.add(t);
		}
		return targets;
	};

	const sendOnce = () => {
		if (!socket) return;
		let msg;
		try { msg = Buffer.from(payload(), "utf8"); } catch { return; }
		for (const t of computeTargets()) {
			try { socket.send(msg, port, t); } catch { /* 单目标失败不致命 */ }
		}
	};

	const start = () => {
		if (enabled === false || socket || timer) return;
		try {
			socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
			socket.on("error", (e) => log?.warn?.(`UDP 广播 socket 错误（发现功能降级）: ${e?.message || e}`));
			socket.bind(() => {
				if (!socket) return; // stop() 已在 bind 前调用
				try { socket.setBroadcast(true); } catch { /* 某些平台默认已开 */ }
				sendOnce();
				const iv = Math.max(1000, Number(intervalMs) || 3000);
				timer = setInterval(sendOnce, iv);
				log?.info?.(`局域网广播已启动: UDP:${port}（每 ${iv / 1000}s，目标每次发送重算）`);
			});
		} catch (e) {
			log?.warn?.(`UDP 广播启动失败（发现功能降级，手动重试路径不受影响）: ${e?.message || e}`);
			socket = null;
		}
	};

	const stop = () => {
		try { if (timer) clearInterval(timer); } catch { /* ignore */ }
		timer = null;
		try { socket?.close(); } catch { /* ignore */ }
		socket = null;
	};

	return { start, stop };
}
