package com.deepseek.harness.mobile

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** 探测结果：某个候选地址可达。 */
data class ProbeResult(val host: String, val mode: String, val dsh: Boolean)

/**
 * 与网关通信的客户端。
 * 探测流程（v1.4.0）：
 *   首选地址(上次成功 host) → 局域网候选并发探测（快速命中）→ 全部失败再并发探测
 *   远程(Tailscale)候选 → 全部失败最后走 UDP 广播发现（PC 换 IP / 新网段自愈）。
 * 发现到的地址仍须经 /pair/probe 令牌校验，确保「广播可见」≠「可连接」。
 * 这实现了「自动检测是否在局域网」：局域网可达则秒连，否则回退到远程。
 */
object GatewayClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(1500, TimeUnit.MILLISECONDS)
        .readTimeout(2000, TimeUnit.MILLISECONDS)
        .callTimeout(2500, TimeUnit.MILLISECONDS)
        .build()

    /**
     * 探测可用的网关地址。
     * @param preferredHost 上次成功连接的 host（ip:port），优先尝试。
     * @param context 用于 UDP 广播发现（MulticastLock）；传 null 则跳过发现。
     */
    suspend fun probe(profile: ConnectionProfile, context: Context? = null, preferredHost: String? = null): ProbeResult? {
        val preferred = preferredHost?.takeIf { it.isNotBlank() && !profile.lan.contains(it) }
        val lanPool = if (preferred != null) listOf(preferred) + profile.lan else profile.lan
        val lan = probeHosts(profile, lanPool, 2200)
        if (lan.isNotEmpty()) return lan.first()
        val wan = probeHosts(profile, profile.wan, 3600)
        if (wan.isNotEmpty()) return wan.first()
        // v1.4.0：UDP 广播发现兜底 —— PC 换 IP / 换网段后自动找回（发现 + 令牌双重校验）
        return discoverProbe(profile, context)
    }

    /** UDP 广播发现 + 令牌校验。仅局域网语义（广播不出网段）。 */
    suspend fun discoverProbe(profile: ConnectionProfile, context: Context?): ProbeResult? {
        if (context == null) return null
        return withContext(Dispatchers.IO) {
            val fp = LanDiscovery.fingerprint(profile.token)
            val found = LanDiscovery.discover(context, fp) ?: return@withContext null
            probeHost(profile, found.host)
        }
    }

    private suspend fun probeHosts(profile: ConnectionProfile, hosts: List<String>, budgetMs: Long): List<ProbeResult> {
        if (hosts.isEmpty()) return emptyList()
        return withContext(Dispatchers.IO) {
            coroutineScope {
                hosts.map { host ->
                    async(Dispatchers.IO) { probeHost(profile, host) }
                }.awaitAll().filterNotNull()
            }
        }
    }

    /** 阻塞式探测单个候选，失败/超时返回 null。 */
    // TODO: 将 token 从 URL query param 改为 Authorization 请求头（需网关配合）
    //        当前 URL 中携带 token 在 HTTP 明文下存在泄露风险。
    private fun probeHost(profile: ConnectionProfile, host: String): ProbeResult? {
        val url = "http://$host/pair/probe?t=${profile.token}"
        return try {
            val req = Request.Builder().url(url).get().build()
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body?.string() ?: ""
                    val dsh = body.contains("\"dsh\":true")
                    val mode = if (profile.isPrivateHost(host)) MODE_LAN else MODE_WAN
                    ProbeResult(host, mode, dsh)
                } else {
                    null
                }
            }
        } catch (e: Exception) {
            null
        }
    }
}
