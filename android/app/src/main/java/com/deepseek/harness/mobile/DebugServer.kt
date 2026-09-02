package com.deepseek.harness.mobile

import android.app.Application
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地调试控制端口（v1.3.2）。
 *
 * 仅绑定 127.0.0.1，不暴露到局域网。用途：通过
 *   adb forward tcp:4747 tcp:4747
 * 从电脑端用 curl 读取/写入配对配置、触发连接，便于在无界面操作条件下诊断
 * 和修复配对问题。
 *
 * 端点（JSON）：
 *   GET  /           服务信息
 *   GET  /status     应用版本 / 前台 Activity / 最近错误 / 是否已连接 / 保存配置摘要
 *   GET  /profile    当前保存配置（token 打码）
 *   POST /profile    body = 完整 dshm://v1/... 或原始 JSON，解析并保存
 *   POST /connect    以保存的配置打开 ConnectActivity（触发连接）
 *   POST /clear      清空保存配置
 *
 * 安全说明：仅监听回环。Android 上其他进程也可访问 127.0.0.1，但本 API 只能
 * 读写本应用的配对配置与触发连接（token 默认打码、不能读取系统数据），风险可控。
 * 如需在对外发布的构建中彻底禁用，可在 DebugServer.start() 增加 BuildConfig 开关。
 */
object DebugServer {
    private const val TAG = "DSHDebug"
    private const val PORT = 4747

    /** 供 /status 使用的运行时状态快照。 */
    object State {
        @Volatile var foregroundActivity: String? = null
        @Volatile var lastError: String? = null
        @Volatile var connected: Boolean = false
    }

    @Volatile
    private var context: Context? = null
    private val started = AtomicBoolean(false)

    /** 幂等启动；绑定失败只记日志，不影响 App 主流程。 */
    fun start(app: Application) {
        if (!started.compareAndSet(false, true)) return
        context = app.applicationContext
        val t = Thread({ acceptLoop() }, "dsh-debug")
        t.isDaemon = true
        t.start()
    }

    private fun acceptLoop() {
        try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            // 优先绑定 IPv4 回环 127.0.0.1：adb forward / nc 默认走 IPv4 回环；
            // 直接 InetAddress.getLoopbackAddress() 在某些进程里会得到 ::1（IPv6），导致 adb forward 连不上（实测）。
            try {
                ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 32)
            } catch (e1: Exception) {
                Log.w(TAG, "bind 127.0.0.1 failed (${e1.message}), falling back to loopback()")
                ss.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), PORT), 32)
            }
            Log.i(TAG, "debug server listening on ${ss.localSocketAddress}")
            while (started.get() && !ss.isClosed) {
                val client = try {
                    ss.accept()
                } catch (e: Exception) {
                    if (started.get()) Log.w(TAG, "accept: ${e.message}")
                    continue
                }
                handle(client)
            }
        } catch (e: Exception) {
            Log.w(TAG, "debug server failed: ${e.message}")
        }
    }

    private fun handle(socket: Socket) {
        try {
            socket.soTimeout = 5000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            val line = reader.readLine() ?: return
            val parts = line.split(" ")
            if (parts.size < 3) return
            val method = parts[0]
            val path = parts[1]

            var contentLength = 0
            while (true) {
                val h = reader.readLine() ?: break
                if (h.isEmpty()) break
                val ci = h.indexOf(':')
                if (ci > 0 && h.substring(0, ci).trim().equals("content-length", ignoreCase = true)) {
                    contentLength = h.substring(ci + 1).trim().toIntOrNull() ?: 0
                }
            }
            var body = ""
            if (contentLength in 1..65536) {
                val buf = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = reader.read(buf, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                body = String(buf, 0, read)
            }

            val ctx = context
            when ("$method $path") {
                "GET /" -> respond(socket, 200, JSONObject().apply {
                    put("name", "dsh-mobile-debug")
                    put("version", BuildConfig.VERSION_NAME)
                    put("endpoints", JSONArray(listOf("/", "/status", "/profile", "POST /profile", "POST /connect", "POST /clear")))
                })
                "GET /status" -> respond(socket, 200, statusJson())
                "GET /profile" -> respond(socket, 200, profileJson())
                "POST /profile" -> handleSetProfile(socket, ctx, body)
                "POST /connect" -> handleConnect(socket, ctx)
                "POST /clear" -> handleClear(socket, ctx)
                else -> respond(socket, 404, JSONObject().put("ok", false).put("error", "not found"))
            }
        } catch (e: Exception) {
            Log.w(TAG, "handle: ${e.message}")
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun statusJson(): JSONObject = JSONObject().apply {
        put("ok", true)
        put("appVersion", BuildConfig.VERSION_NAME)
        put("foregroundActivity", State.foregroundActivity ?: JSONObject.NULL)
        put("connected", State.connected)
        put("lastError", State.lastError ?: JSONObject.NULL)
        put("profile", profileJson())
    }

    private fun profileJson(): JSONObject {
        val ctx = context ?: return JSONObject().put("saved", false)
        val p = ProfileStore.loadProfile(ctx) ?: return JSONObject().put("saved", false)
        return JSONObject().apply {
            put("saved", true)
            put("name", p.name)
            put("port", p.port)
            put("lan", JSONArray(p.lan))
            put("wan", JSONArray(p.wan))
            put("token", mask(p.token))
        }
    }

    private fun mask(t: String): String = if (t.length <= 8) "***" else t.take(4) + "…" + t.takeLast(4)

    private fun handleSetProfile(socket: Socket, ctx: Context?, body: String) {
        if (ctx == null) return respond(socket, 500, JSONObject().put("ok", false).put("error", "no context"))
        val text = body.trim()
        if (text.isEmpty()) return respond(socket, 400, JSONObject().put("ok", false).put("error", "empty body"))
        val profile = ConnectionProfile.fromQrText(text)
        if (profile == null) return respond(socket, 400, JSONObject().put("ok", false).put("error", "cannot parse pairing text"))
        ProfileStore.saveProfile(ctx, profile)
        respond(socket, 200, JSONObject().apply {
            put("ok", true)
            put("name", profile.name)
            put("port", profile.port)
            put("lan", JSONArray(profile.lan))
            put("wan", JSONArray(profile.wan))
        })
    }

    private fun handleConnect(socket: Socket, ctx: Context?) {
        if (ctx == null) return respond(socket, 500, JSONObject().put("ok", false).put("error", "no context"))
        if (ProfileStore.loadProfile(ctx) == null) return respond(socket, 400, JSONObject().put("ok", false).put("error", "no profile"))
        try {
            val intent = Intent(ctx, ConnectActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ctx.startActivity(intent)
            respond(socket, 200, JSONObject().put("ok", true))
        } catch (e: Exception) {
            respond(socket, 500, JSONObject().put("ok", false).put("error", e.message ?: "start activity failed"))
        }
    }

    private fun handleClear(socket: Socket, ctx: Context?) {
        if (ctx == null) return respond(socket, 500, JSONObject().put("ok", false).put("error", "no context"))
        ProfileStore.clear(ctx)
        respond(socket, 200, JSONObject().put("ok", true))
    }

    private fun respond(socket: Socket, status: Int, obj: JSONObject) {
        try {
            val body = obj.toString().toByteArray(Charsets.UTF_8)
            val out: OutputStream = socket.getOutputStream()
            val head = "HTTP/1.1 $status OK\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
        } catch (e: Exception) {
            Log.w(TAG, "respond: ${e.message}")
        }
    }
}
