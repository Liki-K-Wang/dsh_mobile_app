package com.deepseek.harness.mobile

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * 手动输入配对内容对话框（主页与扫描页共用）。
 *
 * 接受完整 `dshm://v1/...` 或原始 JSON；支持一键从剪贴板粘贴；确定前内联校验。
 * 使用 Material3 TextInputLayout 风格。
 */
object ManualInputDialog {

    fun show(context: Context, onProfile: (ConnectionProfile) -> Unit) {
        val density = context.resources.displayMetrics.density
        val pad = (16 * density).toInt()

        val editText = TextInputEditText(context).apply {
            hint = context.getString(R.string.manual_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            minLines = 3
            maxLines = 6
            gravity = Gravity.START or Gravity.TOP
            setPadding(pad, (12 * density).toInt(), pad, (12 * density).toInt())
        }

        val inputLayout = TextInputLayout(context).apply {
            addView(editText)
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            setBoxCornerRadii((8 * density).toFloat(), (8 * density).toFloat(), (8 * density).toFloat(), (8 * density).toFloat())
            boxStrokeColor = context.getColor(R.color.border)
            hintTextColor = androidx.core.content.res.ResourcesCompat.getColorStateList(
                context.resources, R.color.text_tertiary, null
            )
            defaultHintTextColor = androidx.core.content.res.ResourcesCompat.getColorStateList(
                context.resources, R.color.text_tertiary, null
            )
            setPadding(0, (4 * density).toInt(), 0, 0)
        }

        val pasteBtn = MaterialButton(context, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
            text = context.getString(R.string.manual_paste)
            textSize = 13f
            minHeight = (40 * density).toInt()
            icon = context.getDrawable(android.R.drawable.ic_menu_edit)
            iconSize = (18 * density).toInt()
            iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START
            setTextColor(context.getColor(R.color.info))
        }

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, (12 * density).toInt(), pad, 0)
            addView(inputLayout)
            addView(pasteBtn, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.END; topMargin = (4 * density).toInt() })
        }

        val dialog = AlertDialog.Builder(context)
            .setTitle(R.string.manual_title)
            .setView(root)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.confirm, null) // 手动接管，便于内联校验
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val text = editText.text?.toString()?.trim()
                if (text.isNullOrEmpty()) {
                    inputLayout.error = context.getString(R.string.manual_invalid)
                    return@setOnClickListener
                }
                val profile = ConnectionProfile.fromQrText(text)
                if (profile == null) {
                    inputLayout.error = context.getString(R.string.manual_invalid)
                } else {
                    dialog.dismiss()
                    onProfile(profile)
                }
            }
        }

        pasteBtn.setOnClickListener {
            val clipText = clipboardText(context)
            if (clipText == null) {
                inputLayout.error = context.getString(R.string.clipboard_empty)
            } else {
                inputLayout.error = null
                editText.setText(clipText)
                editText.setSelection(clipText.length)
            }
        }

        dialog.show()

        // 打开时若剪贴板里有内容且输入框为空，自动填入（减少一步操作）
        val clip = clipboardText(context)
        if (clip != null && editText.text.isNullOrEmpty()) {
            editText.setText(clip)
            editText.setSelection(clip.length)
        }
    }

    private fun clipboardText(context: Context): String? {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = cm?.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        val text = clip.getItemAt(0).text?.toString()?.trim() ?: return null
        return text.takeIf { it.isNotEmpty() }
    }
}