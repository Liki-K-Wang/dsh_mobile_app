package com.deepseek.harness.mobile

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * 配对连接配置。与网关配对二维码内容一一对应：
 *   dshm://v1/<base64url(JSON)>
 *   JSON: { v, name, port, lan: ["ip:port"...], wan: ["ip:port"...], token }
 */
data class ConnectionProfile(
    val name: String,
    val port: Int,
    val lan: List<String>,
    val wan: List<String>,
    val token: String
) {
    /** 局域网优先，远程其次；去重。 */
    val allHosts: List<String> get() = (lan + wan).distinct()

    /** 以 http 协议拼接候选地址（网关只监听 HTTP；远程经 Tailscale 加密）。 */
    fun urlFor(host: String): String = "http://$host"

    /** 判断 host（ip:port）是否属于私网（局域网）网段。 */
    fun isPrivateHost(host: String): Boolean {
        val h = host.substringBefore(":").substringBefore("/")
        val nums = h.split(".").mapNotNull { it.toIntOrNull() }
        if (nums.size != 4) return false
        return nums[0] == 10 ||
            (nums[0] == 172 && nums[1] in 16..31) ||
            (nums[0] == 192 && nums[1] == 168) ||
            nums[0] == 127
    }

    fun toJson(): String {
        val obj = JSONObject()
        obj.put("v", 1)
        obj.put("name", name)
        obj.put("port", port)
        obj.put("lan", JSONArray(lan))
        obj.put("wan", JSONArray(wan))
        obj.put("token", token)
        return obj.toString()
    }

    companion object {
        private const val PREFIX = "dshm://v1/"

        fun fromQrText(text: String): ConnectionProfile? {
            val trimmed = text.trim()
            // 支持直接粘贴原始 JSON（手动输入场景）
            if (trimmed.startsWith("{")) return fromJson(trimmed)
            if (!trimmed.startsWith(PREFIX)) return null
            val b64 = trimmed.removePrefix(PREFIX)
            val json = try {
                val raw = Base64.decode(b64, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                String(raw, StandardCharsets.UTF_8)
            } catch (e: Exception) {
                try {
                    val raw = Base64.decode(b64, Base64.DEFAULT)
                    String(raw, StandardCharsets.UTF_8)
                } catch (e2: Exception) {
                    return null
                }
            }
            return try {
                val obj = JSONObject(json)
                val lan = jsonArrayToList(obj.optJSONArray("lan"))
                val wan = jsonArrayToList(obj.optJSONArray("wan"))
                ConnectionProfile(
                    name = obj.optString("name", "DSH"),
                    port = obj.optInt("port", 3081),
                    lan = lan,
                    wan = wan,
                    token = obj.getString("token")
                )
            } catch (e: Exception) {
                null
            }
        }

        fun fromJson(json: String): ConnectionProfile? = try {
            val obj = JSONObject(json)
            ConnectionProfile(
                name = obj.optString("name", "DSH"),
                port = obj.optInt("port", 3081),
                lan = jsonArrayToList(obj.optJSONArray("lan")),
                wan = jsonArrayToList(obj.optJSONArray("wan")),
                token = obj.getString("token")
            )
        } catch (e: Exception) {
            null
        }

        private fun jsonArrayToList(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotBlank() } }
        }
    }
}
