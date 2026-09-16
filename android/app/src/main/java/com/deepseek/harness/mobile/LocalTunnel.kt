package com.deepseek.harness.mobile

import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地回环 TCP 隧道（v1.4.1）。
 *
 * 把 WebView 的页面来源变成 http://127.0.0.1:<port>：
 *  - DSH 客户端按页面主机名判定回环（isLoopbackHostname，仅 localhost/[::1]/127.x），
 *    非回环页面的设置作用域跑内存模式且 describe 永不回答 → 模型设置页报
 *    「加载提供方目录失败: settings are unavailable in this browser」。
 *    经本隧道加载后来源为 127.0.0.1 → 回环判定通过，设置页正常；
 *  - localhost 同时是安全上下文（crypto.subtle 等受限 API 全部可用）；
 *  - WebView cookie 绑定 127.0.0.1:port，PC 换 IP 不再影响页面会话。
 *
 * 仅绑定回环，不对外监听；[retarget] 支持 PC 换 IP 后无缝切换目标，
 * 既有连接自然死亡（GUI 的 WS 自愈重连走新目标）。
 */
class LocalTunnel {

    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool { r ->
        Thread(r, "dsh-tunnel").apply { isDaemon = true }
    }
    private val running = AtomicBoolean(false)
    private val open = Collections.synchronizedSet(HashSet<Socket>())

    /** 转发目标 "ip:port"（PC 网关）。@Volatile 保证泵线程即时可见。 */
    @Volatile
    var target: String? = null
        private set

    /** 实际监听端口；未启动为 -1。 */
    var port: Int = -1
        private set

    val isRunning: Boolean get() = running.get()

    /** 启动监听（幂等）。系统分配空闲端口，避免与设备上其它应用冲突。 */
    @Synchronized
    fun start(): Boolean {
        if (running.get()) return true
        return try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress("127.0.0.1", 0))
            server = ss
            port = ss.localPort
            running.set(true)
            pool.execute { acceptLoop(ss) }
            true
        } catch (e: Exception) {
            // 端口/回环绑定失败 → 隧道不可用，调用方回退直连路径
            running.set(false)
            port = -1
            false
        }
    }

    /** 切换转发目标（"ip:port"）。既有连接不受影响，新连接走向新目标。 */
    fun retarget(host: String) {
        target = host
    }

    /** 停止监听并关闭全部连接（onDestroy 调用）。 */
    @Synchronized
    fun stop() {
        running.set(false)
        try { server?.close() } catch (e: Exception) { /* ignore */ }
        server = null
        synchronized(open) {
            for (s in open) try { s.close() } catch (e: Exception) { /* ignore */ }
            open.clear()
        }
        port = -1
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (running.get()) {
            val local = try {
                ss.accept()
            } catch (e: Exception) {
                if (running.get()) continue else return
            }
            pool.execute { handle(local) }
        }
    }

    private fun handle(local: Socket) {
        var remote: Socket? = null
        try {
            local.tcpNoDelay = true
            val t = target
            if (t == null || !running.get()) {
                try { local.close() } catch (e: Exception) { /* ignore */ }
                return
            }
            val ip = t.substringBefore(":")
            val prt = t.substringAfter(":").toIntOrNull(10) ?: 3081
            val r = Socket()
            r.tcpNoDelay = true
            r.connect(InetSocketAddress(ip, prt), 2500)
            remote = r
            open.add(local)
            open.add(r)
            // 双向泵：任一方向结束/异常即两端对齐关闭
            pool.execute { pump(local, r); closeBoth(local, r) }
            pump(r, local)
            closeBoth(local, r)
        } catch (e: Exception) {
            // 连接目标失败/中断 → 关本地，WebView 立即得到错误并走自愈
            try { local.close() } catch (e2: Exception) { /* ignore */ }
            remote?.let { try { it.close() } catch (e2: Exception) { /* ignore */ } }
        } finally {
            open.remove(local)
            remote?.let { open.remove(it) }
        }
    }

    private fun pump(src: Socket, dst: Socket) {
        try {
            val input = src.getInputStream()
            val output = dst.getOutputStream()
            val buf = ByteArray(8192)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (e: Exception) {
            // 半途断开由 closeBoth 统一收尾
        } finally {
            try { dst.shutdownOutput() } catch (e: Exception) { /* ignore */ }
        }
    }

    private fun closeBoth(a: Socket, b: Socket) {
        try { a.close() } catch (e: Exception) { /* ignore */ }
        try { b.close() } catch (e: Exception) { /* ignore */ }
    }
}
