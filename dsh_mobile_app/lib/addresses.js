/**
 * dsh_mobile_app — lib/addresses.js
 *
 * 本机 IPv4 地址收集：私网（LAN）、CGNAT（Tailscale 等，按 WAN 处理）、其它公网。
 * 供配对页候选地址、UDP 广播定向目标与启动日志使用；每次调用实时读取网卡，
 * 调用方需要新鲜结果（如广播目标随网络变化重算）。
 */
import os from "node:os";

/** 私网 v4：10/8、172.16/12、192.168/16、127/8。 */
export function isPrivateV4(a) {
	const p = a.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
	return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 127;
}

/** CGNAT v4：100.64/10（Tailscale 等）。 */
export function isCgnatV4(a) {
	const p = a.split(".").map(Number);
	return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

/** 收集非内部 IPv4 地址，去重后按 lan/wan/other 分组。 */
export function collectAddresses() {
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
