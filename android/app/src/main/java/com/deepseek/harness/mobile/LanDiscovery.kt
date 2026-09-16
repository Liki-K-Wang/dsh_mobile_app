package com.deepseek.harness.mobile

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.security.MessageDigest

/**
 * 局域网 UDP 广播发现（v1.4.0）。
 *
 * PC 端插件（dsh_mobile_app lib/server.js）每 3s 向 255.255.255.255 与各网段定向
 * 广播地址发送：{v:1, app:"dshm-gw", name, port, fp}，其中
 *   fp = sha256(配对令牌) 前 8 位 hex —— 与本文件 [fingerprint] 同算法。
 * 广播载荷不含令牌本体；手机端指纹匹配后取发送方 IP 作为网关候选，再交由
 * GatewayClient 用首次扫码存储的令牌经 /pair/probe 正式校验（双重验证）。
 *
 * 用途：PC 重启 / IP 变更 / 手机离网再回 —— 无需重新扫码，自动发现并恢复连接。
 */
object LanDiscovery {
    /** 与 PC 端 DEFAULTS.broadcastPort 一致。 */
    const val BROADCAST_PORT = 30880
    private const val APP_ID = "dshm-gw"

    /** 令牌指纹：SHA-256 前 8 位 hex（PC 端 tokenFingerprint 同算法，注释互相引用）。 */
    fun fingerprint(token: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(token.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(8)

    /** 发现结果：发送方 IP + 载荷中的端口 + 主机名。 */
    data class Discovered(val host: String, val port: Int, val name: String)

    /**
     * 在 [timeoutMs] 窗口内监听广播，返回第一个指纹匹配 [matchFp] 的网关；超时返回 null。
     * 阻塞式 —— 调用方须在 Dispatchers.IO 上执行。
     * MulticastLock 提升部分机型对广播/组播包的接收可靠性（厂商 WiFi 驱动差异）。
     */
    fun discover(context: Context, matchFp: String, timeoutMs: Long = 3500L): Discovered? {
        if (matchFp.isBlank()) return null
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = try {
            wifi?.createMulticastLock("dsh-discover")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            null
        }
        return try {
            DatagramSocket(null).use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(BROADCAST_PORT))
                socket.soTimeout = 200
                val buf = ByteArray(2048)
                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        socket.receive(pkt)
                    } catch (e: SocketTimeoutException) {
                        continue // 窗口内继续等
                    } catch (e: Exception) {
                        continue // 单包异常不致命
                    }
                    val sender = pkt.address?.hostAddress ?: continue
                    val obj = try {
                        JSONObject(String(pkt.data, pkt.offset, pkt.length, Charsets.UTF_8))
                    } catch (e: Exception) {
                        continue
                    }
                    if (obj.optString("app") != APP_ID) continue
                    if (obj.optString("fp") != matchFp) continue // 不是我配对的那台
                    val port = obj.optInt("port", 0)
                    if (port <= 0) continue
                    val ip = sender.takeIf { it.isNotBlank() } ?: continue
                    return Discovered(host = "$ip:$port", port = port, name = obj.optString("name", "DSH"))
                }
                null
            }
        } catch (e: Exception) {
            null // socket 建立失败（端口被占等）→ 发现降级，走手动路径
        } finally {
            try { lock?.release() } catch (e: Exception) { /* ignore */ }
        }
    }
}
