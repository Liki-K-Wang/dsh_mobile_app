package com.deepseek.harness.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.deepseek.harness.mobile.databinding.ActivityScanBinding
import com.google.android.material.button.MaterialButton
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.ResultPoint
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 自定义扫码页：取景框 + 手电筒 / 相册选图解析 / 手动输入 / 关闭。
 *
 * - 只识别 QR 码；有效配对码返回 RESULT_OK（extra 为 profile json），无效码停留扫描页提示。
 * - 扫到与已保存配置 token 不同的新码时，覆盖前二次确认。
 * - 无相机权限时仍可用相册 / 手动输入完成连接。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var binding: ActivityScanBinding

    private var torchOn = false
    private var resumePending = false
    private val albumOnlyMode: Boolean
        get() = intent.getStringExtra(EXTRA_START_MODE) == MODE_ALBUM

    private val albumLauncher = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            decodeFromUri(uri)
        } else if (albumOnlyMode) {
            // 相册被取消：无相机权限场景下给出兜底提示
            showNoCamera()
        }
    }

    private val cameraPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            binding.barcode.resume()
            startDecode()
        } else {
            showNoCamera()
        }
    }

    private val barcodeCallback = object : BarcodeCallback {
        override fun barcodeResult(result: BarcodeResult) {
            val text = result.text
            if (!text.isNullOrBlank()) runOnUiThread {
                // 扫码成功时触觉反馈
                binding.root.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
                handleDecoded(text)
            }
        }

        override fun possibleResultPoints(resultPoints: List<ResultPoint>) {}
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityScanBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // 明确 edge-to-edge：顶栏/底栏分别让出状态栏与导航栏，预览保持全屏
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
                binding.topBar.updatePadding(top = bars.top)
                binding.bottomBar.updatePadding(bottom = bars.bottom)
            }
            insets
        }

        binding.barcode.setDecoderFactory(DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE)))
        binding.barcode.setStatusText(getString(R.string.scan_hint))

        binding.btnBack.setOnClickListener { finish() }
        binding.btnAlbum.setOnClickListener {
            binding.root.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
            albumLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        binding.btnManual.setOnClickListener {
            binding.root.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
            ManualInputDialog.show(this) { onProfileAccepted(it) }
        }
        binding.btnTorch.setOnClickListener {
            binding.root.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
            toggleTorch()
        }
        if (!hasFlash()) binding.btnTorch.visibility = View.GONE

        if (albumOnlyMode) {
            // 相册模式：跳过相机，直接打开相册选择器（无相机权限时仍可连接）
            albumLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        } else if (hasCameraPermission()) {
            binding.barcode.resume()
            startDecode()
        } else {
            cameraPermLauncher.launch(android.Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        // 从相册/手动输入/权限设置返回后，若已获得权限且未在扫描中则恢复
        if (hasCameraPermission() && resumePending) {
            resumePending = false
            binding.barcode.resume()
            startDecode()
        }
    }

    override fun onPause() {
        binding.barcode.pause()
        super.onPause()
    }

    override fun onDestroy() {
        binding.barcode.pauseAndWait()
        super.onDestroy()
    }

    // ------------------------------------------------------------ 扫描控制
    private fun startDecode() {
        if (isFinishing || !hasCameraPermission()) return
        binding.barcode.decodeSingle(barcodeCallback)
    }

    private fun handleDecoded(text: String) {
        val profile = ConnectionProfile.fromQrText(text)
        if (profile == null) {
            showNotice(getString(R.string.scan_invalid)) { addStandardActions() }
            // 无障碍：提示用户识别失败
            binding.root.announceForAccessibility(getString(R.string.scan_invalid))
            binding.root.postDelayed({ if (!isFinishing) { hideNotice(); startDecode() } }, 3200)
            return
        }
        val existing = ProfileStore.loadProfile(this)
        if (existing != null && existing.token != profile.token) {
            AlertDialog.Builder(this)
                .setTitle(R.string.scan_overwrite_title)
                .setMessage(getString(R.string.scan_overwrite_msg, existing.name))
                .setPositiveButton(R.string.confirm) { _, _ -> onProfileAccepted(profile) }
                .setNegativeButton(R.string.cancel) { _, _ -> startDecode() }
                .setOnCancelListener { startDecode() }
                .show()
        } else {
            onProfileAccepted(profile)
        }
    }

    private fun onProfileAccepted(profile: ConnectionProfile) {
        ProfileStore.saveProfile(this, profile)
        val data = Intent().putExtra(EXTRA_PROFILE, profile.toJson())
        setResult(RESULT_OK, data)
        binding.root.announceForAccessibility(getString(R.string.saved_ok, profile.name))
        finish()
    }

    // ------------------------------------------------------------ 相册选图解析
    private fun decodeFromUri(uri: Uri) {
        showNotice(getString(R.string.scan_album_decoding))
        lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) { decodeImage(uri) }
            if (isFinishing) return@launch
            hideNotice()
            if (text == null) {
                showNotice(getString(R.string.scan_album_failed)) { addStandardActions() }
                binding.root.announceForAccessibility(getString(R.string.scan_album_failed))
                binding.root.postDelayed({ if (!isFinishing) { hideNotice(); startDecode() } }, 3200)
            } else {
                handleDecoded(text)
            }
        }
    }

    @SuppressLint("InlinedApi")
    private fun decodeImage(uri: Uri): String? = runCatching {
        val bmp = if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri)) { decoder, info, _ ->
                val maxDim = maxOf(info.size.width, info.size.height)
                if (maxDim > 1200) decoder.setTargetSampleSize((maxDim / 1200).coerceAtLeast(1))
            }
        } else {
            @Suppress("DEPRECATION")
            // API<28: 先测量尺寸降采样，避免大图 OOM
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, opts)
            }
            val maxDim = maxOf(opts.outWidth, opts.outHeight)
            val sampleSize = if (maxDim > 1200) (maxDim / 1200).coerceAtLeast(1) else 1
            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sampleSize }
            contentResolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, decodeOpts)
            } ?: return@runCatching null
        }
        val w = bmp.width
        val h = bmp.height
        val pixels = IntArray(w * h)
        bmp.getPixels(pixels, 0, w, 0, 0, w, h)
        bmp.recycle()
        val source = RGBLuminanceSource(w, h, pixels)
        val binary = BinaryBitmap(HybridBinarizer(source))
        QRCodeReader().decode(binary).text
    }.getOrNull()

    // ------------------------------------------------------------ 手电筒
    private fun toggleTorch() {
        torchOn = !torchOn
        if (torchOn) binding.barcode.setTorchOn() else binding.barcode.setTorchOff()
        binding.btnTorch.text = getString(if (torchOn) R.string.scan_torch_off else R.string.scan_torch)
        // 手电筒开启时改变图标颜色
        binding.btnTorch.iconTint = androidx.core.content.res.ResourcesCompat.getColorStateList(
            resources,
            if (torchOn) R.color.ok else R.color.text_on_dark,
            null
        )
    }

    private fun hasFlash(): Boolean = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)

    private fun hasCameraPermission(): Boolean =
        checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------ 提示 / 兜底
    private fun showNoCamera() {
        binding.barcode.pause()
        showNotice(getString(R.string.scan_no_camera)) {
            addStandardActions()
            addAction(getString(R.string.scan_go_settings)) { openAppSettings() }
        }
        binding.root.announceForAccessibility(getString(R.string.scan_no_camera))
    }

    private fun openAppSettings() {
        try {
            val intent = Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            resumePending = true
        } catch (e: Exception) {
            // ignore
        }
    }

    private fun showNotice(msg: String, actions: (() -> Unit)? = null) {
        binding.noticeText.text = msg
        binding.noticeActions.removeAllViews()
        actions?.invoke()
        binding.noticeBar.isVisible = true
        // 滑入动画
        binding.noticeBar.translationY = -20f
        binding.noticeBar.alpha = 0f
        binding.noticeBar.animate()
            .translationY(0f)
            .alpha(1f)
            .setDuration(250)
            .setInterpolator(androidx.interpolator.view.animation.FastOutSlowInInterpolator())
            .start()
    }

    private fun hideNotice() {
        binding.noticeBar.animate()
            .alpha(0f)
            .setDuration(200)
            .withEndAction {
                binding.noticeBar.isVisible = false
                binding.noticeActions.removeAllViews()
            }
            .start()
    }

    private fun addStandardActions() {
        addAction(getString(R.string.scan_album)) {
            albumLauncher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        addAction(getString(R.string.scan_manual)) {
            ManualInputDialog.show(this) { onProfileAccepted(it) }
        }
    }

    private fun addAction(label: String, onClick: () -> Unit) {
        val btn = MaterialButton(this, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
            text = label
            textSize = 14f
            setTextColor(getColor(R.color.info))
        }
        btn.setOnClickListener {
            binding.root.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
            onClick()
        }
        binding.noticeActions.addView(
            btn,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        )
    }

    companion object {
        const val EXTRA_PROFILE = "profile"
        const val EXTRA_START_MODE = "start_mode"
        const val MODE_ALBUM = "album"
    }
}