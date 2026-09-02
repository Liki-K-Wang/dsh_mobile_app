package com.deepseek.harness.mobile

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 连接配置持久化。优先使用 EncryptedSharedPreferences（Android Keystore 加密）；
 * 若设备不支持（如个别模拟器/异常）则回退到普通私有 SharedPreferences，保证可用性。
 *
 * 实例会懒加载缓存，避免每次调用都触发 MasterKey 构建（昂贵的 Keystore 操作）。
 */
object ProfileStore {
    private const val TAG = "DSHProfileStore"
    private const val PREF = "dsh_profile"
    private const val KEY_PROFILE = "profile_json"
    private const val KEY_LAST_HOST = "last_host"
    private const val KEY_LAST_MODE = "last_mode"

    @Volatile
    private var cachedPrefs: SharedPreferences? = null
    @Volatile
    private var cacheContext: Context? = null

    private fun prefs(context: Context): SharedPreferences {
        // 缓存无效时重新创建（context 变化或首次调用）
        val cached = cachedPrefs
        if (cached != null && cacheContext === context.applicationContext) {
            return cached
        }
        return synchronized(this) {
            cachedPrefs?.takeIf { cacheContext === context.applicationContext }
                ?: createPrefs(context.applicationContext).also {
                    cachedPrefs = it
                    cacheContext = context.applicationContext
                }
        }
    }

    private fun createPrefs(context: Context): SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            PREF,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.w(TAG, "EncryptedSharedPreferences unavailable, falling back to plain SharedPreferences", e)
        if (BuildConfig.DEBUG) {
            // 在 debug 构建中通过主线程提示（仅首次，避免重复弹 Toast）
            android.os.Handler(context.mainLooper).post {
                android.widget.Toast.makeText(
                    context,
                    "设备不支持加密存储，连接配置将以明文保存",
                    android.widget.Toast.LENGTH_LONG
                ).show()
            }
        }
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
    }

    fun saveProfile(context: Context, profile: ConnectionProfile) {
        prefs(context).edit().putString(KEY_PROFILE, profile.toJson()).apply()
    }

    fun loadProfile(context: Context): ConnectionProfile? {
        val json = prefs(context).getString(KEY_PROFILE, null) ?: return null
        return ConnectionProfile.fromJson(json)
    }

    fun setLast(context: Context, host: String, mode: String) {
        prefs(context).edit()
            .putString(KEY_LAST_HOST, host)
            .putString(KEY_LAST_MODE, mode)
            .apply()
    }

    fun lastHost(context: Context): String? = prefs(context).getString(KEY_LAST_HOST, null)
    fun lastMode(context: Context): String? = prefs(context).getString(KEY_LAST_MODE, null)

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
