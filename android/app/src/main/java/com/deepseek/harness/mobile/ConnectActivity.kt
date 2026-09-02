package com.deepseek.harness.mobile

import android.annotation.SuppressLint
import android.content.Intent
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
                webReady = true
                showWeb()
            }

            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
                super.onReceivedHttpError(view, request, errorResponse)
                val status = errorResponse?.statusCode ?: 0
                if (request?.isForMainFrame == true && status == 401) {
                    showError(getString(R.string.session_expired))
                } else if (request?.isForMainFrame == true && status == 502) {
                    showError(getString(R.string.dsh_not_ready))
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true && error?.errorCode != WebViewClient.ERROR_HOST_LOOKUP) {
                    showError(error?.description?.toString() ?: getString(R.string.load_failed))
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

    // 仅允许在同配对的 host 内导航；其它一律拦截（防钓鱼/越域）
    private fun allowNavigation(url: String): Boolean {
        val host = currentHost ?: return false
        val u = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val scheme = u.scheme
        if (scheme != "http" && scheme != "https") return false
        val hostPart = u.host ?: return false
        val portPart = if (u.port > 0) ":${u.port}" else ""
        return hostPart + portPart == host
    }

    // ------------------------------------------------------------ 连接流程
    private fun connect() {
        val p = profile ?: return
        showLoading(getString(R.string.connect_lan))
        probeJob = lifecycleScope.launch {
            val result = GatewayClient.probe(p)
            if (!isFinishing) {
                if (result == null) {
                    showError(getString(R.string.err_no_reachable))
                    return@launch
                }
                if (!result.dsh) {
                    showError(getString(R.string.dsh_not_ready))
                    return@launch
                }
                currentHost = result.host
                mode = result.mode
                ProfileStore.setLast(this@ConnectActivity, result.host, result.mode)
                updateModeBadge(result.mode)
                showLoading(getString(R.string.opening_ui))
                // TODO: token 在 URL 查询参数中传递存在安全风险；
                //       待网关支持 Authorization 头后改为通过请求头注入。
                val url = p.urlFor(result.host) + "/?token=" + p.token
                webView.loadUrl(url)
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

    override fun onDestroy() {
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