package com.deepseek.harness.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import com.deepseek.harness.mobile.BuildConfig
import com.deepseek.harness.mobile.databinding.ActivityConnectBinding
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 连接会话页：探测局域网/远程 → 加载 DSH Web GUI 到加固的 WebView。
 *
 * 无独立顶栏 —— WebView 全屏，DSH 自带 conversation header。
 * 侧边栏入口为 Web 端「对话标题行最左侧」的图标（v1.3.7 起不再有原生浮动按钮，
 * 由 dsh_mobile_app 插件的 #dsh-sidebar-toggle 触发覆盖式抽屉）。
 */
class ConnectActivity : AppCompatActivity() {

    private lateinit var binding: ActivityConnectBinding
    private lateinit var webView: WebView

    private var profile: ConnectionProfile? = null
    private var currentHost: String? = null
    private var mode: String = MODE_UNKNOWN
    private var webReady = false
    private var probeJob: Job? = null

    // v1.4.0 断线自愈状态：自动重连计数 / 重连中标记 / 网络监听
    private var autoRetries = 0
    private var reconnecting = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // v1.4.1 本地回环隧道：页面来源变 127.0.0.1（回环 + 安全上下文），模型设置页可用
    private val tunnel = LocalTunnel()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityConnectBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // 明确 edge-to-edge + 手动应用系统栏 inset：
        // WebView 整体保持在状态栏/导航栏下方（v1.3.6：顶部也下垫 bars.top，
        // 主界面与设置弹窗都不再与状态栏重叠，也不再需要 --dsh-statusbar-top 变量）
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                v.setPadding(0, bars.top, 0, bars.bottom)
            }
            insets
        }
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = binding.webView
        setupWebView()
        setupBack()
        armNetworkWatch()

        binding.btnRetry.setOnClickListener { connect() }
        binding.btnCancel.setOnClickListener { cancelConnect() }
        // 「重新配对」非破坏性：不清空配置，返回主页并自动打开扫码页
        binding.btnRescan.setOnClickListener {
            setResult(RESULT_OK, Intent().putExtra(EXTRA_ACTION, ACTION_RESCAN))
            finish()
        }

        profile = ProfileStore.loadProfile(this)
        if (profile == null) {
            showError(getString(R.string.no_profile))
            return
        }
        // 恢复上次模式徽标
        ProfileStore.lastMode(this)?.let { m ->
            mode = m
            updateModeBadge(m)
        }
        connect()
    }

    // ------------------------------------------------------------ WebView 初始化（安全加固）
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        // 仅 debug 构建开启 WebView 远程调试；release 构建强制关闭
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.mediaPlaybackRequiresUserGesture = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        // 注：setAppCacheEnabled/setAppCachePath 已从 compileSdk 36 的 API 中移除
        //（Chromium 废弃了 AppCache），HTTP 缓存加速由上面的 LOAD_DEFAULT 提供。
        // 原生容器身份标记：UA 带 DSHNative（v1.3.7 起补丁不再据此判定，仅作识别信息保留）
        settings.userAgentString = WebSettings.getDefaultUserAgent(this) + " DSHNative/1"

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                return !allowNavigation(url.toString())
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return url != null && !allowNavigation(url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // v1.4.0：重连中触发的 onPageFinished（失败加载的错误页）不展示
                if (reconnecting) return
                webReady = true
                showWeb()
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                super.onReceivedHttpError(view, request, errorResponse)
                val status = errorResponse?.statusCode ?: 0
                // v1.4.0：主帧 401/502 不再直接报错 —— 401（会话失效）可经重连重取 token 恢复，
                // 502（DSH 未就绪）可能是电脑重启中；自动重连上限内自愈，超过才落错误页
                if (request?.isForMainFrame == true && status == 401) {
                    onConnectFailed(getString(R.string.session_expired))
                } else if (request?.isForMainFrame == true && status == 502) {
                    onConnectFailed(getString(R.string.dsh_not_ready))
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                // v1.4.0：主帧错误（含 ERROR_HOST_LOOKUP —— PC 换 IP/换网段后旧地址失联）
                // 一律走自动重连，UDP 广播发现兜底找回新地址；连续失败才落错误页
                if (request?.isForMainFrame == true) {
                    onConnectFailed(error?.description?.toString() ?: getString(R.string.load_failed))
                }
            }
        }

        // 渲染进程崩溃统一交由 onReceivedError 兜底，保证跨版本稳定。

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.webProgress.progress = newProgress
                binding.webProgress.isVisible = newProgress < 100
            }
        }
    }

    // 仅允许在同配对的 host 与本地隧道来源内导航；其它一律拦截（防钓鱼/越域）
    private fun allowNavigation(url: String): Boolean {
        val u = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val scheme = u.scheme
        if (scheme != "http" && scheme != "https") return false
        // v1.4.1：本地隧道来源（127.0.0.1:<tunnelPort>）——页面实际运行在这里
        if (tunnel.isRunning && u.host == "127.0.0.1" && u.port == tunnel.port) return true
        val host = currentHost ?: return false
        val hostPart = u.host ?: return false
        val portPart = if (u.port > 0) ":${u.port}" else ""
        return hostPart + portPart == host
    }

    // ------------------------------------------------------------ 连接流程
    /** 用户主动连接/重试：重置自动重连计数后执行完整流程。 */
    private fun connect() {
        autoRetries = 0
        reconnecting = false
        runConnect()
    }

    /** 完整探测 + 加载流程：首选上次 host → 局域网候选 → 远程候选 → UDP 广播发现。 */
    private fun runConnect() {
        val p = profile ?: return
        showLoading(getString(R.string.connect_lan))
        probeJob?.cancel()
        probeJob = lifecycleScope.launch {
            val preferred = ProfileStore.lastHost(this@ConnectActivity)
            val result = GatewayClient.probe(p, this@ConnectActivity, preferred)
            if (!isFinishing) {
                if (result == null) {
                    onConnectFailed(getString(R.string.err_no_reachable))
                    return@launch
                }
                if (!result.dsh) {
                    onConnectFailed(getString(R.string.dsh_not_ready))
                    return@launch
                }
                autoRetries = 0
                reconnecting = false
                currentHost = result.host
                mode = result.mode
                ProfileStore.setLast(this@ConnectActivity, result.host, result.mode)
                healProfile(p, result.host)
                updateModeBadge(result.mode)
                showLoading(getString(R.string.opening_ui))
                // v1.4.1：本地回环隧道 —— 页面来源 127.0.0.1（回环判定 + 安全上下文），
                // 模型设置等依赖回环身份的功能可用；隧道目标指向探测成功的网关
                tunnel.retarget(result.host)
                val origin = if (tunnel.start()) "http://127.0.0.1:${tunnel.port}" else p.urlFor(result.host)
                // TODO: token 在 URL 查询参数中传递存在安全风险；
                //       待网关支持 Authorization 头后改为通过请求头注入。
                val url = "$origin/?token=" + p.token
                webView.loadUrl(url)
            }
        }
    }

    /**
     * v1.4.0 断线自愈入口：失败时自动重连（上限 3 次，指数间隔），超过才落错误页。
     * 网络抖动 / PC 重启 / 换 IP 场景下用户无感知恢复。
     */
    private fun onConnectFailed(msg: String) {
        if (autoRetries < 3) {
            autoRetries++
            reconnecting = true
            showLoading(getString(R.string.reconnecting))
            probeJob?.cancel()
            probeJob = lifecycleScope.launch {
                delay(1200L * autoRetries) // 1.2s/2.4s/3.6s —— 给 WiFi 重连与 DHCP 一点时间
                runConnect()
            }
        } else {
            autoRetries = 0
            reconnecting = false
            showError(msg)
        }
    }

    /**
     * v1.4.0 配置自愈：连接成功后把实际可达的 host 提到 profile.lan 首位并重存。
     * PC 换 IP 后手机端自动记住新地址，下次连接省去发现流程。
     */
    private fun healProfile(p: ConnectionProfile, host: String) {
        if (p.lan.firstOrNull() == host) return
        val healed = p.copy(lan = listOf(host) + p.lan.filter { it != host })
        ProfileStore.saveProfile(this, healed)
        profile = healed
    }

    /**
     * v1.4.0 网络监听：WiFi 回来/切换时自动自愈。
     *  - 错误页可见 → 立即重连
     *  - 正在重连等待 → 立即重连（不等延迟）
     *  - Web 正常显示 → 静默重验：探测到 PC 换了地址则无感迁移
     */
    private fun armNetworkWatch() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread { onNetworkAvailable() }
            }
        }
        try {
            cm.registerNetworkCallback(request, networkCallback!!)
        } catch (e: Exception) {
            networkCallback = null // 注册失败只降级：无网络事件驱动的自愈，手动重试仍可用
        }
    }

    private fun onNetworkAvailable() {
        if (isFinishing) return
        when {
            binding.errorOverlay.isVisible -> connect()
            binding.loadingOverlay.isVisible && reconnecting -> connect()
            webReady -> migrateIfHostMoved()
        }
    }

    /** 静默重验：Web 正常时后台探测，发现 PC 地址变更则无感迁移 WebView。 */
    private fun migrateIfHostMoved() {
        val p = profile ?: return
        val old = currentHost ?: return
        probeJob?.cancel()
        probeJob = lifecycleScope.launch {
            val r = GatewayClient.probe(p, this@ConnectActivity, old)
            if (!isFinishing && webReady && r != null && r.dsh && r.host != old) {
                currentHost = r.host
                mode = r.mode
                ProfileStore.setLast(this@ConnectActivity, r.host, r.mode)
                healProfile(p, r.host)
                updateModeBadge(r.mode)
                // v1.4.1：隧道改指新 IP；页面来源不变（127.0.0.1），reload 让 WS 立即走新目标
                tunnel.retarget(r.host)
                if (!tunnel.isRunning) tunnel.start()
                val origin = if (tunnel.isRunning) "http://127.0.0.1:${tunnel.port}" else p.urlFor(r.host)
                webView.loadUrl("$origin/?token=" + p.token)
            }
        }
    }

    private fun cancelConnect() {
        probeJob?.cancel()
        probeJob = null
        webView.stopLoading()
        finish()
    }

    // ------------------------------------------------------------ 界面状态切换
    private fun showLoading(status: String) {
        binding.loadingStatus.text = status
        binding.loadingOverlay.isVisible = true
        binding.errorOverlay.isVisible = false
        binding.webView.isVisible = false
        binding.webProgress.isVisible = false
        // 模式徽标在加载中显示
        binding.modeBadge.isVisible = mode != MODE_UNKNOWN
    }

    private fun showWeb() {
        binding.loadingOverlay.isVisible = false
        binding.errorOverlay.isVisible = false
        binding.webView.isVisible = true
        binding.modeBadge.isVisible = false
        DebugServer.State.connected = true
        DebugServer.State.lastError = null
    }

    private fun showError(msg: String) {
        binding.loadingOverlay.isVisible = false
        binding.webView.isVisible = false
        binding.webProgress.isVisible = false
        binding.errorText.text = msg
        binding.errorOverlay.isVisible = true
        DebugServer.State.connected = false
        DebugServer.State.lastError = msg
    }

    /** 更新模式徽标 Chip 的颜色和文字 */
    private fun updateModeBadge(mode: String) {
        binding.modeBadge.text = modeLabel(mode)
        binding.modeBadge.chipBackgroundColor = androidx.core.content.res.ResourcesCompat.getColorStateList(
            resources,
            if (mode == MODE_LAN) R.color.ok_container
            else if (mode == MODE_WAN) R.color.info_container
            else R.color.surface_alt,
            null
        )
        binding.modeBadge.setTextColor(
            if (mode == MODE_LAN) getColor(R.color.ok)
            else if (mode == MODE_WAN) getColor(R.color.info)
            else getColor(R.color.text_secondary)
        )
    }

    // ------------------------------------------------------------ 返回键：先退 WebView 历史
    private fun setupBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webReady && webView.canGoBack()) webView.goBack()
                else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        // v1.4.0：亮屏回 App 时错误页自动重试一次（离网再回场景的主要入口之一）
        if (this::binding.isInitialized && binding.errorOverlay.isVisible) {
            connect()
        }
    }

    override fun onDestroy() {
        // v1.4.0：释放网络监听，避免泄漏
        networkCallback?.let { cb ->
            try { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } catch (e: Exception) { /* ignore */ }
        }
        networkCallback = null
        // v1.4.1：停止本地回环隧道
        tunnel.stop()
        // 释放 WebView，避免内存泄漏
        try {
            webView.stopLoading()
            webView.settings.javaScriptEnabled = false
            webView.destroy()
        } catch (e: Exception) {
            // ignore
        }
        super.onDestroy()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        const val EXTRA_ACTION = "action"
        const val ACTION_RESCAN = "rescan"
    }
}