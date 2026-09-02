package com.deepseek.harness.mobile

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.interpolator.view.animation.FastOutSlowInInterpolator

class MainActivity : AppCompatActivity() {

    private lateinit var binding: com.deepseek.harness.mobile.databinding.ActivityMainBinding

    // 扫码页返回：RESULT_OK 携带配对配置
    private val scanLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            val json = result.data?.getStringExtra(ScanActivity.EXTRA_PROFILE)
            val profile = json?.let { ConnectionProfile.fromJson(it) }
            if (profile != null) onProfile(profile) else toast(getString(R.string.invalid_qr))
        }
    }

    // 连接页返回：action=rescan -> 直接进入扫码页（不清理配置）
    private val connectLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.data?.getStringExtra(ConnectActivity.EXTRA_ACTION) == ConnectActivity.ACTION_RESCAN) {
            launchScanner()
        }
    }

    // 主页点「扫码连接」时先申请相机权限（快速失败路径）
    private val cameraPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchScanner() else showPermissionDialog()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = com.deepseek.harness.mobile.databinding.ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // 明确 edge-to-edge + 手动应用系统栏 inset：主页内容保持在状态栏下方（跨 API 一致）
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                v.setPadding(0, bars.top, 0, bars.bottom)
            }
            insets
        }

        // 图标呼吸动画
        startIconAnimation()

        binding.btnScan.setOnClickListener {
            if (checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                launchScanner()
            } else {
                cameraPermLauncher.launch(android.Manifest.permission.CAMERA)
            }
        }
        binding.btnManual.setOnClickListener { ManualInputDialog.show(this) { onProfile(it) } }
        binding.btnConnect.setOnClickListener { openConnect() }
        binding.savedCard.setOnClickListener { openConnect() }
        binding.btnDelete.setOnClickListener {
            AlertDialog.Builder(this)
                .setMessage(R.string.delete_confirm)
                .setPositiveButton(R.string.btn_delete) { _, _ ->
                    ProfileStore.clear(this)
                    toast(getString(R.string.deleted))
                    refreshSaved()
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
        }
        refreshSaved()
    }

    override fun onResume() {
        super.onResume()
        refreshSaved()
    }

    /** 图标呼吸动画：轻微缩放，引导用户点击 */
    private fun startIconAnimation() {
        val animator = ValueAnimator.ofFloat(1f, 1.06f).apply {
            duration = 1800
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            interpolator = AccelerateDecelerateInterpolator()
            addUpdateListener { update ->
                val scale = update.animatedValue as Float
                binding.appIcon.scaleX = scale
                binding.appIcon.scaleY = scale
            }
        }
        animator.start()
    }

    private fun launchScanner() {
        scanLauncher.launch(Intent(this, ScanActivity::class.java))
    }

    /** 无相机权限时的出路：相册 / 手动输入 / 去设置 */
    private fun showPermissionDialog() {
        val items = arrayOf(
            getString(R.string.perm_album),
            getString(R.string.btn_manual),
            getString(R.string.perm_settings)
        )
        AlertDialog.Builder(this)
            .setTitle(R.string.perm_title)
            .setMessage(R.string.perm_msg)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> scanLauncher.launch(
                        Intent(this, ScanActivity::class.java).putExtra(ScanActivity.EXTRA_START_MODE, "album")
                    )
                    1 -> ManualInputDialog.show(this) { onProfile(it) }
                    2 -> openAppSettings()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun openAppSettings() {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } catch (e: Exception) {
            // ignore
        }
    }

    private fun onProfile(profile: ConnectionProfile) {
        ProfileStore.saveProfile(this, profile)
        toast(getString(R.string.saved_ok, profile.name))
        refreshSaved()
        openConnect()
    }

    private fun openConnect() {
        if (ProfileStore.loadProfile(this) == null) {
            toast(getString(R.string.no_profile))
            return
        }
        connectLauncher.launch(Intent(this, ConnectActivity::class.java))
    }

    private fun refreshSaved() {
        val profile = ProfileStore.loadProfile(this)
        val has = profile != null
        binding.savedCard.visibility = if (has) View.VISIBLE else View.GONE
        binding.emptyState.visibility = if (has) View.GONE else View.VISIBLE
        if (has) {
            binding.savedName.text = profile!!.name
            val last = ProfileStore.lastHost(this)
            binding.savedHost.text = last?.let { getString(R.string.last_connect, it) } ?: getString(R.string.not_connected)
            val mode = ProfileStore.lastMode(this)
            // 用 Chip 显示模式
            binding.savedMode.text = modeLabel(mode)
            binding.savedMode.chipBackgroundColor = androidx.core.content.res.ResourcesCompat.getColorStateList(
                resources,
                if (mode == MODE_LAN) R.color.ok_container
                else if (mode == MODE_WAN) R.color.info_container
                else R.color.surface_alt,
                null
            )
            binding.savedMode.setTextColor(
                if (mode == MODE_LAN) getColor(R.color.ok)
                else if (mode == MODE_WAN) getColor(R.color.info)
                else getColor(R.color.text_secondary)
            )
            // 左侧色条颜色
            binding.savedAccent.setBackgroundColor(
                if (mode == MODE_LAN) getColor(R.color.ok)
                else if (mode == MODE_WAN) getColor(R.color.primary)
                else getColor(R.color.border)
            )
            // 卡片入场动画
            if (binding.savedCard.alpha == 0f) {
                binding.savedCard.alpha = 0f
                binding.savedCard.translationY = 20f
                binding.savedCard.animate()
                    .alpha(1f)
                    .translationY(0f)
                    .setDuration(300)
                    .setInterpolator(FastOutSlowInInterpolator())
                    .start()
            }
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}