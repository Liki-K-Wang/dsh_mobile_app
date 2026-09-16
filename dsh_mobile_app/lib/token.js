/**
 * dsh_mobile_app — lib/token.js
 *
 * 配对令牌的持久化、合法性校验与指纹。
 *  - 令牌为 43 字符 base64url（256-bit randomBytes），v0.4.0 起持久化到
 *    ~/.dsh/mobile-gateway-token（跨重启稳定，手机首次扫码存储的令牌终身有效）；
 *  - tokenFingerprint：sha256 前 8 位 hex，供 UDP 广播零泄露预匹配（手机端同算法）。
 */
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 默认令牌文件：~/.dsh/mobile-gateway-token（~/.dsh 目录必然存在）。 */
export function defaultTokenFile() {
	try { return path.join(os.homedir(), ".dsh", "mobile-gateway-token"); } catch { return ""; }
}

/** 合法令牌：43 字符 base64url（256-bit randomBytes 的 base64url 形态）。 */
export function isValidToken(s) {
	return typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
}

/** 读取持久化令牌；不存在/损坏返回 ""。任何异常都降级为空（调用方重新生成）。 */
export function readTokenFile(file, log) {
	if (!file) return "";
	try {
		const raw = fs.readFileSync(file, "utf8").trim();
		if (isValidToken(raw)) return raw;
		log?.warn?.(`token file 内容不合法，忽略并重新生成: ${file}`);
	} catch (e) {
		if (e?.code !== "ENOENT") log?.warn?.(`token file 读取失败（降级为新生成）: ${e?.message || e}`);
	}
	return "";
}

/** 写入持久化令牌；失败仅告警（令牌仍在内存中有效，本次进程内不受影响）。 */
export function writeTokenFile(file, token, log) {
	if (!file) return;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, token + "\n", { encoding: "utf8", mode: 0o600 });
	} catch (e) {
		log?.warn?.(`token file 写入失败（令牌仅本次进程内有效）: ${e?.message || e}`);
	}
}

/** 令牌指纹：sha256 前 8 位 hex，供 UDP 广播做零泄露预匹配（手机端同算法）。 */
export function tokenFingerprint(token) {
	return crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}
